import { Inject, Injectable } from '@nestjs/common';
import { FeeLine, FeeScheduleRow, applicationFeeLines, counterPaymentSchema, formatSerial, maskNid } from '@dscc/domain';
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

  /** Create the registration + fitness fee invoice for an application if it has none (idempotent). */
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

  static view(inv: { id: string; invoiceNo: string; status: string; totalBdt: number; lines: unknown; createdAt: Date; paidAt: Date | null }, payments: { method: string; providerRef: string; amountBdt: number; status: string; receiptNo: string | null; createdAt: Date }[] = []) {
    return {
      id: inv.id,
      invoiceNo: inv.invoiceNo,
      status: inv.status,
      totalBdt: inv.totalBdt,
      lines: inv.lines as FeeLine[],
      createdAt: inv.createdAt,
      paidAt: inv.paidAt,
      payments: payments.map((p) => ({ method: p.method, reference: p.providerRef, amountBdt: p.amountBdt, status: p.status, receiptNo: p.receiptNo, at: p.createdAt })),
    };
  }

  // ─── Citizen: start a (simulated) online payment ───
  async checkout(userId: string, applicationId: string) {
    if (!UUID_RE.test(applicationId)) throw notFound();
    const city = await this.cities.defaultCity();
    return this.prisma.inCity(city.id, async (tx) => {
      const app = await tx.application.findFirst({ where: { id: applicationId, applicantUserId: userId, deletedAt: null } });
      if (!app) throw notFound();
      if (!['SUBMITTED', 'UNDER_VERIFICATION', 'CORRECTION_REQUESTED'].includes(app.status)) throw conflict('APPLICATION_INVALID_STATE');
      const seatType = (app.formData as { vehicle?: { seatType?: string } }).vehicle?.seatType ?? 'TWO_SEAT';
      const inv = await this.ensureInvoice(tx, { cityId: city.id, cityCode: city.code, applicationId: app.id, seatType });
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
    await notifyApplicant(tx, this.outbox, app.applicantUserId, `DSCC ই-রিকশা: আবেদন ${app.applicationNumber}-এর ফি ${p.amountBdt} টাকা গৃহীত হয়েছে। রশিদ নং ${receiptNo}।`);
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
      const appRows = await tx.application.findMany({ where: { id: { in: invoices.map((i) => i.applicationId) } } });
      const owners = await tx.ownerIdentity.findMany({ where: { id: { in: appRows.map((a) => a.ownerIdentityId) } } });
      const amap = new Map(appRows.map((a) => [a.id, a]));
      const omap = new Map(owners.map((o) => [o.id, o]));
      return invoices.map((i) => {
        const a = amap.get(i.applicationId);
        const o = a ? omap.get(a.ownerIdentityId) : undefined;
        return {
          ...FeesService.view(i, i.payments),
          application: a ? { id: a.id, applicationNumber: a.applicationNumber, status: a.status } : null,
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
}
