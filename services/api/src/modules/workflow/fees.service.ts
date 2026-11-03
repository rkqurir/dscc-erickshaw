import { Inject, Injectable } from '@nestjs/common';
import { FITNESS_REQUEST_STATUSES, FeeLine, FeeScheduleRow, applicationFeeLines, counterPaymentSchema, fitnessFeeLines, formatSerial, maskNid } from '@dscc/domain';
import { randomBytes } from 'node:crypto';
import { z } from 'zod';
import { AppConfig, CONFIG } from '../../config';
import { AuditService, canonicalJson } from '../../platform/audit.service';
import { CityService } from '../../platform/city.service';
import { hmacB64url, safeEqualStr } from '../../platform/crypto';
import { AppError, badRequest, conflict, notFound, parseOrThrow } from '../../platform/errors';
import { OutboxService } from '../../platform/outbox.service';
import { PrismaService, Tx } from '../../platform/prisma.service';
import { nextSerial } from '../../platform/serials';
import { StaffContext } from '../auth/guards';
import { UUID_RE, dhakaToday, isoDate, notifyApplicant, zoneFilter } from './scope';

const SESSION_TTL_MS = 30 * 60_000;

export const callbackSchema = z.object({
  city: z.string().regex(/^[A-Z]{2,8}$/),
  sessionId: z.string().regex(UUID_RE),
  gatewayTxnId: z.string().regex(/^[A-Za-z0-9_-]{6,64}$/),
  amountBdt: z.number().int().positive(),
  outcome: z.enum(['SUCCESS', 'FAILED']),
  at: z.string(),
});
export type PaymentCallback = z.infer<typeof callbackSchema>;

export const refundCompletionSchema = z.object({
  reference: z
    .string()
    .trim()
    .transform((s) => s.toUpperCase())
    .refine((s) => /^[A-Z0-9\-/]{4,40}$/.test(s), { message: 'SERIAL_INVALID' }),
});

const REGISTRATION_PAYABLE = new Set(['SUBMITTED', 'UNDER_VERIFICATION', 'CORRECTION_REQUESTED']);

type InvoiceRow = Awaited<ReturnType<Tx['invoice']['findFirstOrThrow']>>;
type RefundRow = Awaited<ReturnType<Tx['refund']['findFirstOrThrow']>>;

/** How the applicant's SMS names the application: its number once submitted, the chassis number before. */
export function applicationLabel(app: { applicationNumber: string | null; formData: unknown }): string {
  if (app.applicationNumber) return `আবেদন ${app.applicationNumber}`;
  const chassis = (app.formData as { vehicle?: { chassisNo?: string } })?.vehicle?.chassisNo;
  return chassis ? `চেসিস ${chassis}` : 'খসড়া আবেদন';
}

/**
 * Schedule 2 fees and payments. Every invoice stores the fee-schedule rows it was priced from, so a
 * later change to the schedule never alters an issued invoice or receipt. A payment is only ever
 * confirmed by a signed gateway callback or a revenue officer's counter entry — never by a browser redirect.
 * Paying does not approve anything: approval is a separate officer decision (Phase 0, payments rule).
 */
@Injectable()
export class FeesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly cities: CityService,
    private readonly audit: AuditService,
    private readonly outbox: OutboxService,
    @Inject(CONFIG) private readonly config: AppConfig,
  ) {}

  async scheduleRows(tx: Tx): Promise<FeeScheduleRow[]> {
    const rows = await tx.feeSchedule.findMany({ orderBy: [{ service: 'asc' }, { effectiveFrom: 'asc' }] });
    return rows.map((r) => ({
      id: r.id,
      service: r.service,
      seatType: r.seatType,
      amountBdt: r.amountBdt,
      effectiveFrom: isoDate(r.effectiveFrom)!,
      effectiveTo: isoDate(r.effectiveTo),
      legalRef: r.legalRef,
    }));
  }

  /** Create the registration fee invoice for an application if it has none (idempotent). */
  async ensureInvoice(tx: Tx, p: { cityId: string; cityCode: string; applicationId: string; seatType: string; onDate?: string }) {
    const existing = await tx.invoice.findFirst({ where: { applicationId: p.applicationId, purpose: 'NEW_REGISTRATION', status: { not: 'CANCELLED' } } });
    if (existing) return existing;
    const onDate = p.onDate ?? dhakaToday();
    let lines: FeeLine[];
    try {
      lines = applicationFeeLines(await this.scheduleRows(tx), p.seatType, onDate);
    } catch {
      throw new AppError('FEE_SCHEDULE_MISSING', 500);
    }
    const year = Number(onDate.slice(0, 4));
    const invoiceNo = formatSerial('INV', p.cityCode, year, await nextSerial(tx, p.cityId, 'INVOICE', String(year)));
    return tx.invoice.create({
      data: {
        cityId: p.cityId,
        applicationId: p.applicationId,
        invoiceNo,
        purpose: 'NEW_REGISTRATION',
        status: 'UNPAID',
        totalBdt: lines.reduce((n, l) => n + l.amountBdt, 0),
        lines: lines as unknown as object,
      },
    });
  }

  /** A new fitness fee invoice for one inspection request. */
  async createFitnessInvoice(tx: Tx, p: { cityId: string; cityCode: string; applicationId: string; seatType: string }) {
    const onDate = dhakaToday();
    let lines: FeeLine[];
    try {
      lines = fitnessFeeLines(await this.scheduleRows(tx), p.seatType, onDate);
    } catch {
      throw new AppError('FEE_SCHEDULE_MISSING', 500);
    }
    const year = Number(onDate.slice(0, 4));
    const invoiceNo = formatSerial('INV', p.cityCode, year, await nextSerial(tx, p.cityId, 'INVOICE', String(year)));
    return tx.invoice.create({
      data: { cityId: p.cityId, applicationId: p.applicationId, invoiceNo, purpose: 'FITNESS', status: 'UNPAID', totalBdt: lines.reduce((n, l) => n + l.amountBdt, 0), lines: lines as unknown as object },
    });
  }

  static view(
    inv: { id: string; invoiceNo: string; purpose?: string; status: string; totalBdt: number; lines: unknown; createdAt: Date; paidAt: Date | null },
    payments: { method: string; providerRef: string; amountBdt: number; status: string; receiptNo: string | null; createdAt: Date }[] = [],
    refunds: RefundRow[] = [],
  ) {
    return {
      id: inv.id,
      invoiceNo: inv.invoiceNo,
      purpose: inv.purpose ?? 'NEW_REGISTRATION',
      status: inv.status,
      totalBdt: inv.totalBdt,
      lines: inv.lines as FeeLine[],
      createdAt: inv.createdAt,
      paidAt: inv.paidAt,
      payments: payments.map((p) => ({ method: p.method, reference: p.providerRef, amountBdt: p.amountBdt, status: p.status, receiptNo: p.receiptNo, at: p.createdAt })),
      refunds: refunds.map(FeesService.refundView),
    };
  }

  static refundView(r: RefundRow) {
    return { id: r.id, method: r.method, amountBdt: r.amountBdt, status: r.status, reason: r.reason, reference: r.providerRef, createdAt: r.createdAt, completedAt: r.completedAt };
  }

  // ─── Citizen: start a (simulated) online payment ───
  /**
   * Pay one of the application's unpaid invoices: the given one, otherwise the oldest. A fitness invoice
   * can be paid from the draft (fitness comes before the application); the registration invoice once submitted.
   */
  async checkout(userId: string, applicationId: string, invoiceId?: unknown) {
    if (!UUID_RE.test(applicationId)) throw notFound();
    if (invoiceId !== undefined && (typeof invoiceId !== 'string' || !UUID_RE.test(invoiceId))) throw notFound();
    const city = await this.cities.defaultCity();
    return this.prisma.inCity(city.id, async (tx) => {
      const app = await tx.application.findFirst({ where: { id: applicationId, applicantUserId: userId, deletedAt: null } });
      if (!app) throw notFound();
      let inv: InvoiceRow | null;
      if (invoiceId) {
        inv = await tx.invoice.findFirst({ where: { id: invoiceId, applicationId: app.id } });
        if (!inv) throw notFound();
      } else {
        inv = await tx.invoice.findFirst({ where: { applicationId: app.id, status: 'UNPAID' }, orderBy: { createdAt: 'asc' } });
        if (!inv && REGISTRATION_PAYABLE.has(app.status)) {
          const seatType = (app.formData as { vehicle?: { seatType?: string } }).vehicle?.seatType ?? 'TWO_SEAT';
          inv = await this.ensureInvoice(tx, { cityId: city.id, cityCode: city.code, applicationId: app.id, seatType });
        }
        if (!inv) throw conflict('INVOICE_ALREADY_PAID');
      }
      const payable = inv.purpose === 'FITNESS' ? FITNESS_REQUEST_STATUSES.has(app.status) : REGISTRATION_PAYABLE.has(app.status);
      if (!payable) throw conflict('APPLICATION_INVALID_STATE');
      if (inv.status !== 'UNPAID') throw conflict('INVOICE_ALREADY_PAID');
      const session = await tx.paymentSession.create({
        data: { cityId: city.id, invoiceId: inv.id, userId, status: 'PENDING', amountBdt: inv.totalBdt, expiresAt: new Date(Date.now() + SESSION_TTL_MS) },
      });
      await this.audit.record(tx, { cityId: city.id, actorType: 'USER', actorId: userId, action: 'payment.checkout_started', entityType: 'invoice', entityId: inv.id, data: { sessionId: session.id, amountBdt: inv.totalBdt } });
      return { sessionId: session.id, gatewayUrl: `/pay/sim/${session.id}`, amountBdt: inv.totalBdt, invoiceNo: inv.invoiceNo };
    });
  }

  // ─── Payment simulator (stands in for the government gateway until Gate D) ───
  async simulatorSession(userId: string, sessionId: string) {
    if (!UUID_RE.test(sessionId)) throw notFound();
    const city = await this.cities.defaultCity();
    return this.prisma.inCity(city.id, async (tx) => {
      const s = await tx.paymentSession.findFirst({ where: { id: sessionId, userId } });
      if (!s) throw notFound();
      const inv = await tx.invoice.findUniqueOrThrow({ where: { id: s.invoiceId } });
      return { sessionId: s.id, status: s.status, amountBdt: s.amountBdt, invoiceNo: inv.invoiceNo, applicationId: inv.applicationId, expiresAt: s.expiresAt };
    });
  }

  signCallback(payload: PaymentCallback): string {
    return hmacB64url(this.config.PAYMENT_WEBHOOK_SECRET, canonicalJson(payload));
  }

  /** The simulated gateway decides the outcome and calls the webhook handler with a signed callback. */
  async simulatorComplete(userId: string, sessionId: string, outcome: 'SUCCESS' | 'FAILED') {
    const info = await this.simulatorSession(userId, sessionId);
    const city = await this.cities.defaultCity();
    const payload: PaymentCallback = {
      city: city.code,
      sessionId,
      gatewayTxnId: `SIM${randomBytes(9).toString('base64url')}`,
      amountBdt: info.amountBdt,
      outcome,
      at: new Date().toISOString(),
    };
    const result = await this.handleCallback(payload, this.signCallback(payload));
    return { ...result, applicationId: info.applicationId };
  }

  /** Signed, idempotent gateway callback. Unknown or replayed transactions never double-credit. */
  async handleCallback(body: unknown, signature: string | undefined): Promise<{ status: string; receiptNo?: string }> {
    const parsed = callbackSchema.safeParse(body);
    if (!parsed.success || !signature) throw new AppError('PAYMENT_SIGNATURE_INVALID', 401);
    const payload = parsed.data;
    if (!safeEqualStr(this.signCallback(payload), signature)) throw new AppError('PAYMENT_SIGNATURE_INVALID', 401);
    const city = await this.cities.byCode(payload.city).catch(() => null);
    if (!city) throw new AppError('PAYMENT_SIGNATURE_INVALID', 401);
    return this.prisma.inCity(city.id, async (tx) => {
      const dup = await tx.payment.findUnique({ where: { method_providerRef: { method: 'ONLINE_SIMULATOR', providerRef: payload.gatewayTxnId } } });
      if (dup) return { status: 'DUPLICATE', receiptNo: dup.receiptNo ?? undefined };
      await tx.$queryRaw`SELECT id FROM payment_sessions WHERE id = ${payload.sessionId}::uuid FOR UPDATE`;
      const session = await tx.paymentSession.findUnique({ where: { id: payload.sessionId } });
      if (!session) throw notFound();
      await tx.$queryRaw`SELECT id FROM invoices WHERE id = ${session.invoiceId}::uuid FOR UPDATE`;
      const inv = await tx.invoice.findUniqueOrThrow({ where: { id: session.invoiceId } });
      const fail = async (reason: string) => {
        await tx.payment.create({
          data: { cityId: city.id, invoiceId: inv.id, method: 'ONLINE_SIMULATOR', providerRef: payload.gatewayTxnId, amountBdt: payload.amountBdt, status: 'FAILED', details: { reason, sessionId: session.id } },
        });
        if (session.status === 'PENDING') await tx.paymentSession.update({ where: { id: session.id }, data: { status: 'FAILED', closedAt: new Date() } });
        await this.audit.record(tx, { cityId: city.id, actorType: 'SYSTEM', action: 'payment.failed', entityType: 'invoice', entityId: inv.id, data: { reason, gatewayTxnId: payload.gatewayTxnId } });
        return { status: 'FAILED' };
      };
      if (payload.outcome === 'FAILED') return fail('GATEWAY_DECLINED');
      if (session.status !== 'PENDING') return fail(`SESSION_${session.status}`);
      if (session.expiresAt.getTime() < Date.now()) return fail('SESSION_EXPIRED');
      if (inv.status !== 'UNPAID') return fail('INVOICE_NOT_UNPAID'); // already settled elsewhere: refund case for revenue
      if (payload.amountBdt !== inv.totalBdt) return fail('AMOUNT_MISMATCH');
      const receiptNo = await this.settle(tx, { cityId: city.id, cityCode: city.code, invoice: inv, method: 'ONLINE_SIMULATOR', providerRef: payload.gatewayTxnId, amountBdt: payload.amountBdt, details: { sessionId: session.id, gatewayAt: payload.at } });
      await tx.paymentSession.update({ where: { id: session.id }, data: { status: 'COMPLETED', closedAt: new Date() } });
      return { status: 'PAID', receiptNo };
    });
  }

  private async settle(
    tx: Tx,
    p: { cityId: string; cityCode: string; invoice: { id: string; applicationId: string; invoiceNo: string }; method: string; providerRef: string; amountBdt: number; details: object; staffId?: string },
  ): Promise<string> {
    const year = Number(dhakaToday().slice(0, 4));
    const receiptNo = formatSerial('RCP', p.cityCode, year, await nextSerial(tx, p.cityId, 'RECEIPT', String(year)));
    await tx.payment.create({
      data: { cityId: p.cityId, invoiceId: p.invoice.id, method: p.method, providerRef: p.providerRef, amountBdt: p.amountBdt, status: 'SUCCEEDED', receiptNo, recordedByStaff: p.staffId ?? null, details: p.details },
    });
    await tx.invoice.update({ where: { id: p.invoice.id }, data: { status: 'PAID', paidAt: new Date() } });
    const app = await tx.application.findUniqueOrThrow({ where: { id: p.invoice.applicationId } });
    await this.audit.record(tx, {
      cityId: p.cityId,
      actorType: p.staffId ? 'STAFF' : 'SYSTEM',
      actorId: p.staffId ?? null,
      action: 'payment.succeeded',
      entityType: 'invoice',
      entityId: p.invoice.id,
      data: { method: p.method, reference: p.providerRef, amountBdt: p.amountBdt, receiptNo, applicationNumber: app.applicationNumber },
    });
    await notifyApplicant(tx, this.outbox, app.applicantUserId, `DSCC ই-রিকশা: ${applicationLabel(app)}-এর ফি ${p.amountBdt} টাকা গৃহীত হয়েছে। রশিদ নং ${receiptNo}।`);
    return receiptNo;
  }

  // ─── Revenue officer ───
  async listInvoices(s: StaffContext, q: { status?: string }) {
    const scope = zoneFilter(s);
    return this.prisma.inCity(s.cityId, async (tx) => {
      const apps = scope ? await tx.application.findMany({ where: { zoneId: { in: scope } }, select: { id: true } }) : null;
      const invoices = await tx.invoice.findMany({
        where: { ...(q.status ? { status: q.status } : {}), ...(apps ? { applicationId: { in: apps.map((a) => a.id) } } : {}) },
        orderBy: { createdAt: 'desc' },
        take: 200,
        include: { payments: { orderBy: { createdAt: 'asc' } } },
      });
      const refunds = await tx.refund.findMany({ where: { invoiceId: { in: invoices.map((i) => i.id) } }, orderBy: { createdAt: 'asc' } });
      const appRows = await tx.application.findMany({ where: { id: { in: invoices.map((i) => i.applicationId) } } });
      const owners = await tx.ownerIdentity.findMany({ where: { id: { in: appRows.map((a) => a.ownerIdentityId) } } });
      const amap = new Map(appRows.map((a) => [a.id, a]));
      const omap = new Map(owners.map((o) => [o.id, o]));
      return invoices.map((i) => {
        const a = amap.get(i.applicationId);
        const o = a ? omap.get(a.ownerIdentityId) : undefined;
        return {
          ...FeesService.view(i, i.payments, refunds.filter((r) => r.invoiceId === i.id)),
          application: a ? { id: a.id, applicationNumber: a.applicationNumber, status: a.status, label: applicationLabel(a) } : null,
          owner: o ? { nameBn: o.nameBn, nidMasked: maskNid(o.nidLast4) } : null,
        };
      });
    });
  }

  async recordCounterPayment(s: StaffContext, invoiceId: string, body: unknown, ip: string | null) {
    const input = parseOrThrow(counterPaymentSchema, body);
    if (!UUID_RE.test(invoiceId)) throw notFound();
    if (input.paidOn > dhakaToday()) throw badRequest('VALIDATION_FAILED', { fields: { paidOn: 'DATE_INVALID' } });
    const city = await this.cities.byId(s.cityId);
    const scope = zoneFilter(s);
    return this.prisma.inCity(s.cityId, async (tx) => {
      await tx.$queryRaw`SELECT id FROM invoices WHERE id = ${invoiceId}::uuid FOR UPDATE`;
      const inv = await tx.invoice.findUnique({ where: { id: invoiceId } });
      if (!inv) throw notFound();
      if (scope) {
        const app = await tx.application.findUniqueOrThrow({ where: { id: inv.applicationId } });
        if (!app.zoneId || !scope.includes(app.zoneId)) throw notFound();
      }
      if (inv.status !== 'UNPAID') throw conflict('INVOICE_ALREADY_PAID');
      if (input.amountBdt !== inv.totalBdt) throw badRequest('PAYMENT_AMOUNT_MISMATCH', { expected: inv.totalBdt });
      const used = await tx.payment.findUnique({ where: { method_providerRef: { method: 'COUNTER_CHALLAN', providerRef: input.challanNo } } });
      if (used) throw conflict('CHALLAN_ALREADY_USED');
      const receiptNo = await this.settle(tx, {
        cityId: s.cityId,
        cityCode: city.code,
        invoice: inv,
        method: 'COUNTER_CHALLAN',
        providerRef: input.challanNo,
        amountBdt: input.amountBdt,
        details: { paidOn: input.paidOn, bankName: input.bankName, ip },
        staffId: s.staffId,
      });
      return { status: 'PAID', receiptNo };
    });
  }

  // ─── Refunds (DSCC decision, 2026-11-02: fees are returned when a rejection becomes final) ───

  /**
   * Refund every paid invoice of the application. Online payments go back through the gateway at once
   * (simulator); a bank challan refund waits for a revenue officer to record the bank reference.
   * Idempotent: a payment is refunded at most once (unique payment_id).
   */
  async refundApplication(tx: Tx, p: { cityId: string; applicationId: string; reason: string; actor: { type: 'STAFF' | 'SYSTEM'; id: string | null } }) {
    const invoices = await tx.invoice.findMany({ where: { applicationId: p.applicationId, status: 'PAID' } });
    let total = 0;
    let pending = 0;
    for (const inv of invoices) {
      const payment = await tx.payment.findFirst({ where: { invoiceId: inv.id, status: 'SUCCEEDED' } });
      if (!payment || (await tx.refund.findUnique({ where: { paymentId: payment.id } }))) continue;
      const online = payment.method === 'ONLINE_SIMULATOR';
      const refund = await tx.refund.create({
        data: {
          cityId: p.cityId,
          applicationId: p.applicationId,
          invoiceId: inv.id,
          paymentId: payment.id,
          method: payment.method,
          amountBdt: payment.amountBdt,
          reason: p.reason,
          status: online ? 'COMPLETED' : 'PENDING',
          providerRef: online ? `SIMRF${randomBytes(9).toString('base64url')}` : null,
          completedAt: online ? new Date() : null,
        },
      });
      if (online) await tx.invoice.update({ where: { id: inv.id }, data: { status: 'REFUNDED' } });
      else pending++;
      total += refund.amountBdt;
      await this.audit.record(tx, {
        cityId: p.cityId,
        actorType: p.actor.type,
        actorId: p.actor.id,
        action: online ? 'refund.completed' : 'refund.pending',
        entityType: 'invoice',
        entityId: inv.id,
        data: { refundId: refund.id, amountBdt: refund.amountBdt, method: refund.method, reason: p.reason, reference: refund.providerRef },
      });
    }
    if (total > 0) {
      const app = await tx.application.findUniqueOrThrow({ where: { id: p.applicationId } });
      const how = pending ? 'ব্যাংক চালানে জমা দেওয়া অংশ ব্যাংকের মাধ্যমে ফেরত দেওয়া হবে।' : 'টাকা যে মাধ্যমে দিয়েছিলেন সেখানে ফেরত যাবে।';
      await notifyApplicant(tx, this.outbox, app.applicantUserId, `DSCC ই-রিকশা: ${applicationLabel(app)} চূড়ান্তভাবে না-মঞ্জুর হওয়ায় ${total} টাকা ফেরত দেওয়া হচ্ছে। ${how}`);
    }
    return { total, pending };
  }

  async listRefunds(s: StaffContext, q: { status?: string }) {
    const scope = zoneFilter(s);
    return this.prisma.inCity(s.cityId, async (tx) => {
      const apps = scope ? await tx.application.findMany({ where: { zoneId: { in: scope } }, select: { id: true } }) : null;
      const rows = await tx.refund.findMany({
        where: { ...(q.status ? { status: q.status } : {}), ...(apps ? { applicationId: { in: apps.map((a) => a.id) } } : {}) },
        orderBy: { createdAt: 'desc' },
        take: 200,
      });
      const [appRows, invoices, payments] = await Promise.all([
        tx.application.findMany({ where: { id: { in: rows.map((r) => r.applicationId) } } }),
        tx.invoice.findMany({ where: { id: { in: rows.map((r) => r.invoiceId) } } }),
        tx.payment.findMany({ where: { id: { in: rows.map((r) => r.paymentId) } } }),
      ]);
      const owners = await tx.ownerIdentity.findMany({ where: { id: { in: appRows.map((a) => a.ownerIdentityId) } } });
      const amap = new Map(appRows.map((a) => [a.id, a]));
      const imap = new Map(invoices.map((i) => [i.id, i]));
      const pmap = new Map(payments.map((x) => [x.id, x]));
      const omap = new Map(owners.map((o) => [o.id, o]));
      return rows.map((r) => {
        const a = amap.get(r.applicationId);
        const o = a ? omap.get(a.ownerIdentityId) : undefined;
        const pay = pmap.get(r.paymentId);
        return {
          ...FeesService.refundView(r),
          invoiceNo: imap.get(r.invoiceId)?.invoiceNo ?? null,
          paidReference: pay?.providerRef ?? null,
          receiptNo: pay?.receiptNo ?? null,
          application: a ? { id: a.id, applicationNumber: a.applicationNumber, status: a.status, label: applicationLabel(a) } : null,
          owner: o ? { nameBn: o.nameBn, nidMasked: maskNid(o.nidLast4) } : null,
        };
      });
    });
  }

  /** A revenue officer records the bank reference of a challan refund. */
  async completeRefund(s: StaffContext, refundId: string, body: unknown) {
    const input = parseOrThrow(refundCompletionSchema, body);
    if (!UUID_RE.test(refundId)) throw notFound();
    const scope = zoneFilter(s);
    return this.prisma.inCity(s.cityId, async (tx) => {
      await tx.$queryRaw`SELECT id FROM refunds WHERE id = ${refundId}::uuid FOR UPDATE`;
      const r = await tx.refund.findUnique({ where: { id: refundId } });
      if (!r) throw notFound();
      const app = await tx.application.findUniqueOrThrow({ where: { id: r.applicationId } });
      if (scope && (!app.zoneId || !scope.includes(app.zoneId))) throw notFound();
      if (r.status !== 'PENDING') throw conflict('REFUND_ALREADY_COMPLETED');
      const upd = await tx.refund.update({ where: { id: r.id }, data: { status: 'COMPLETED', providerRef: input.reference, completedAt: new Date(), completedByStaff: s.staffId } });
      await tx.invoice.update({ where: { id: r.invoiceId }, data: { status: 'REFUNDED' } });
      await this.audit.record(tx, { cityId: s.cityId, actorType: 'STAFF', actorId: s.staffId, action: 'refund.completed', entityType: 'invoice', entityId: r.invoiceId, data: { refundId: r.id, amountBdt: r.amountBdt, reference: input.reference } });
      await notifyApplicant(tx, this.outbox, app.applicantUserId, `DSCC ই-রিকশা: ${applicationLabel(app)}-এর ${r.amountBdt} টাকা ফেরত দেওয়া হয়েছে। ব্যাংক রেফারেন্স ${input.reference}।`);
      return FeesService.refundView(upd);
    });
  }
}
