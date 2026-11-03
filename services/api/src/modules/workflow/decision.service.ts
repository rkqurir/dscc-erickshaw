import { Injectable, Logger } from '@nestjs/common';
import {
  APPEAL_WINDOW_WORKING_DAYS,
  APPROVAL_GATES,
  ApplicationStatus,
  ApprovalGate,
  addWorkingDays,
  appealDecisionSchema,
  appealSchema,
  approvalSchema,
  checklistComplete,
  correctionRequestSchema,
  gatesSatisfied,
  maskNid,
  nextStatus,
  rejectionSchema,
  verificationCheckSchema,
} from '@dscc/domain';
import { AuditService } from '../../platform/audit.service';
import { CityService } from '../../platform/city.service';
import { AppError, conflict, forbidden, notFound, parseOrThrow } from '../../platform/errors';
import { OutboxService } from '../../platform/outbox.service';
import { PrismaService, Tx } from '../../platform/prisma.service';
import { StaffContext } from '../auth/guards';
import { StepUpService } from '../auth/step-up.service';
import { QuotaService } from '../owners/quota.service';
import { FeesService } from './fees.service';
import { InspectionService } from './inspection.service';
import { UUID_RE, dhakaToday, isoDate, loadStaffApplication, notifyApplicant, zoneFilter } from './scope';

type AppRow = Awaited<ReturnType<Tx['application']['findFirstOrThrow']>>;

const REASON_BN: Record<string, string> = {
  OWNER_INELIGIBLE: 'আবেদনকারী যোগ্য নন',
  NID_NOT_VERIFIED: 'NID যাচাই হয়নি',
  DOCUMENTS_INVALID: 'নথি সঠিক নয়',
  FALSE_DECLARATION: 'মিথ্যা তথ্য/ঘোষণা',
  VEHICLE_NOT_APPROVED_MODEL: 'অনুমোদিত মডেল নয়',
  FITNESS_FAILED: 'ফিটনেস অনুত্তীর্ণ',
  ZONE_QUOTA_FULL: 'জোনের নির্ধারিত সংখ্যা পূর্ণ',
  DUPLICATE_VEHICLE: 'একই গাড়ির দ্বৈত আবেদন',
  OTHER: 'অন্যান্য',
};

/**
 * Officer verification, correction requests, the protected approval/rejection decision and the
 * Rule 4(7) appeal. All state changes follow the domain transition table, run in one transaction with
 * their status event, audit entry and SMS, and are re-checked by database triggers.
 */
@Injectable()
export class DecisionService {
  private readonly log = new Logger('Decisions');

  constructor(
    private readonly prisma: PrismaService,
    private readonly cities: CityService,
    private readonly audit: AuditService,
    private readonly outbox: OutboxService,
    private readonly quota: QuotaService,
    private readonly fees: FeesService,
    private readonly stepUp: StepUpService,
  ) {}

  private async transition(tx: Tx, app: AppRow, to: ApplicationStatus, actor: { type: 'STAFF' | 'USER' | 'SYSTEM'; id: string | null }, note: string | null, extra: object = {}) {
    await tx.application.update({ where: { id: app.id }, data: { status: to, version: { increment: 1 }, ...extra } });
    await tx.applicationStatusEvent.create({
      data: { applicationId: app.id, cityId: app.cityId, fromStatus: app.status, toStatus: to, actorType: actor.type, actorId: actor.id, note },
    });
  }

  // ─── Verification ───
  async startVerification(s: StaffContext, id: string) {
    const city = await this.cities.byId(s.cityId);
    return this.prisma.inCity(s.cityId, async (tx) => {
      const app = await loadStaffApplication(tx, s, id, true);
      const to = nextStatus(app.status as ApplicationStatus, 'START_VERIFICATION');
      if (!to) throw conflict('APPLICATION_INVALID_STATE');
      await this.transition(tx, app, to, { type: 'STAFF', id: s.staffId }, null, { verifiedByStaffId: s.staffId, verificationStartedAt: new Date() });
      const seatType = (app.formData as { vehicle?: { seatType?: string } }).vehicle?.seatType ?? 'TWO_SEAT';
      await this.fees.ensureInvoice(tx, { cityId: s.cityId, cityCode: city.code, applicationId: app.id, seatType, onDate: app.submittedAt ? isoDate(new Date(app.submittedAt.getTime() + 6 * 3600_000))! : undefined });
      await this.audit.record(tx, { cityId: s.cityId, actorType: 'STAFF', actorId: s.staffId, action: 'application.verification_started', entityType: 'application', entityId: app.id });
      return { id: app.id, status: to };
    });
  }

  async recordCheck(s: StaffContext, id: string, body: unknown) {
    const input = parseOrThrow(verificationCheckSchema, body);
    return this.prisma.inCity(s.cityId, async (tx) => {
      const app = await loadStaffApplication(tx, s, id, true);
      if (app.status !== 'UNDER_VERIFICATION') throw conflict('APPLICATION_INVALID_STATE');
      await tx.verificationCheck.create({ data: { cityId: s.cityId, applicationId: app.id, item: input.item, result: input.result, note: input.note ?? null, staffId: s.staffId } });
      // Until the Election Commission service is contracted (Gate D), the officer's identity check against
      // the uploaded NID copy is the manual NID verification (Phase 0, section 6).
      if (input.item === 'OWNER_IDENTITY' && input.result === 'PASS') {
        const owner = await tx.ownerIdentity.findUniqueOrThrow({ where: { id: app.ownerIdentityId } });
        if (owner.verificationStatus === 'PENDING_MANUAL') {
          await tx.ownerIdentity.update({ where: { id: owner.id }, data: { verificationStatus: 'VERIFIED', verificationSource: `manual:${s.staffId}`, verifiedAt: new Date() } });
        }
      }
      await this.audit.record(tx, { cityId: s.cityId, actorType: 'STAFF', actorId: s.staffId, action: 'application.check_recorded', entityType: 'application', entityId: app.id, data: { item: input.item, result: input.result } });
      return { ok: true };
    });
  }

  async requestCorrection(s: StaffContext, id: string, body: unknown) {
    const input = parseOrThrow(correctionRequestSchema, body);
    return this.prisma.inCity(s.cityId, async (tx) => {
      const app = await loadStaffApplication(tx, s, id, true);
      const to = nextStatus(app.status as ApplicationStatus, 'REQUEST_CORRECTION');
      if (!to) throw conflict('APPLICATION_INVALID_STATE');
      await tx.correctionRequest.create({ data: { cityId: s.cityId, applicationId: app.id, items: input.items, message: input.message, requestedBy: s.staffId } });
      await this.transition(tx, app, to, { type: 'STAFF', id: s.staffId }, input.message);
      await this.audit.record(tx, { cityId: s.cityId, actorType: 'STAFF', actorId: s.staffId, action: 'application.correction_requested', entityType: 'application', entityId: app.id, data: { items: input.items } });
      await notifyApplicant(tx, this.outbox, app.applicantUserId, `DSCC ই-রিকশা: আবেদন ${app.applicationNumber} সংশোধন প্রয়োজন: ${input.message.slice(0, 200)} পোর্টালে লগইন করে সংশোধন করে আবার জমা দিন।`);
      return { id: app.id, status: to };
    });
  }

  // ─── Approval gates ───
  async computeGates(tx: Tx, app: AppRow, staffId: string | null): Promise<{ gates: Record<ApprovalGate, boolean>; unmet: ApprovalGate[]; detail: Record<string, unknown> }> {
    const owner = await tx.ownerIdentity.findUniqueOrThrow({ where: { id: app.ownerIdentityId } });
    const checks = await tx.verificationCheck.findMany({ where: { applicationId: app.id }, orderBy: { createdAt: 'asc' } });
    const checklist = checklistComplete(checks.map((c) => ({ item: c.item, result: c.result, at: c.createdAt })));
    const openCorrection = await tx.correctionRequest.findFirst({ where: { applicationId: app.id, resolvedAt: null } });
    const fv = (app.formData as { vehicle?: { chassisNo?: string; motorNo?: string } }).vehicle;
    const cert = await InspectionService.validCertificate(tx, app.id, dhakaToday(), fv?.chassisNo && fv?.motorNo ? { chassisNo: fv.chassisNo, motorNo: fv.motorNo } : undefined);
    const invoice = await tx.invoice.findFirst({ where: { applicationId: app.id, purpose: 'NEW_REGISTRATION', status: { not: 'CANCELLED' } } });
    let quotaOk = true;
    let zoneQuota: { quota: number; used: number } | null = null;
    if (app.zoneId) {
      const zone = await tx.zone.findUniqueOrThrow({ where: { id: app.zoneId } });
      if (zone.vehicleQuota !== null) {
        const used = await tx.vehicle.count({ where: { zoneId: zone.id, status: { in: ['APPROVED', 'ACTIVE', 'SUSPENDED'] } } });
        zoneQuota = { quota: zone.vehicleQuota, used };
        quotaOk = used < zone.vehicleQuota;
      }
    }
    const separationOk = staffId === null || (app.verifiedByStaffId !== staffId && !checks.some((c) => c.staffId === staffId));
    const gates: Record<ApprovalGate, boolean> = {
      STATUS_UNDER_VERIFICATION: app.status === 'UNDER_VERIFICATION',
      OWNER_NID_VERIFIED: owner.verificationStatus === 'VERIFIED' || owner.verificationStatus === 'SIMULATED_VERIFIED',
      CHECKLIST_COMPLETE: checklist.complete,
      NO_OPEN_CORRECTION: !openCorrection,
      FITNESS_CERTIFICATE_VALID: !!cert,
      FEES_PAID: invoice?.status === 'PAID',
      ZONE_QUOTA_AVAILABLE: quotaOk,
      SEPARATION_OF_DUTIES: separationOk,
    };
    return {
      gates,
      unmet: gatesSatisfied(gates),
      detail: {
        checklist: checklist.items,
        ownerVerification: owner.verificationStatus,
        fitnessCertificate: cert ? { certificateNo: cert.certificateNo, validUntil: isoDate(cert.validUntil) } : null,
        invoice: invoice ? { invoiceNo: invoice.invoiceNo, status: invoice.status, totalBdt: invoice.totalBdt } : null,
        zoneQuota,
      },
    };
  }

  async approve(s: StaffContext, id: string, body: unknown, ip: string | null) {
    const input = parseOrThrow(approvalSchema, body);
    return this.prisma.inCity(s.cityId, async (tx) => {
      const app = await loadStaffApplication(tx, s, id, true);
      if (app.zoneId) await tx.$queryRaw`SELECT id FROM zones WHERE id = ${app.zoneId}::uuid FOR UPDATE`; // serialise zone quota (Rule 3)
      const g = await this.computeGates(tx, app, s.staffId);
      if (!g.gates.SEPARATION_OF_DUTIES) throw forbidden('SEPARATION_OF_DUTIES');
      await this.stepUp.verify(tx, s.staffId, input.totp, 'approve');
      if (g.unmet.length) throw new AppError('APPROVAL_GATES_NOT_MET', 409, { unmet: g.unmet });
      const to = nextStatus(app.status as ApplicationStatus, 'APPROVE')!;
      await tx.applicationDecision.create({
        data: { cityId: s.cityId, applicationId: app.id, decision: 'APPROVED', reasonCodes: [], reasonText: input.note ?? null, decidedBy: s.staffId, gates: { ...g.gates, ...g.detail } as object },
      });
      await this.transition(tx, app, to, { type: 'STAFF', id: s.staffId }, input.note ?? null, { decidedAt: new Date() });
      await tx.vehicle.update({ where: { id: app.vehicleId! }, data: { status: 'APPROVED' } });
      await tx.$executeRaw`UPDATE vehicle_quota_slots SET state = 'HELD' WHERE vehicle_id = ${app.vehicleId}::uuid AND state = 'RESERVED'`;
      await this.audit.record(tx, { cityId: s.cityId, actorType: 'STAFF', actorId: s.staffId, action: 'application.approved', entityType: 'application', entityId: app.id, data: { applicationNumber: app.applicationNumber, gates: g.gates }, ip });
      await notifyApplicant(tx, this.outbox, app.applicantUserId, `DSCC ই-রিকশা: অভিনন্দন! আবেদন ${app.applicationNumber} অনুমোদিত হয়েছে। নম্বর প্লেট ও QR কোড ইস্যুর পর আপনাকে জানানো হবে।`);
      return { id: app.id, status: to };
    });
  }

  async reject(s: StaffContext, id: string, body: unknown, ip: string | null) {
    const input = parseOrThrow(rejectionSchema, body);
    const holidays = await this.cities.holidays();
    return this.prisma.inCity(s.cityId, async (tx) => {
      const app = await loadStaffApplication(tx, s, id, true);
      const to = nextStatus(app.status as ApplicationStatus, 'REJECT');
      if (!to) throw conflict('APPLICATION_INVALID_STATE');
      const g = await this.computeGates(tx, app, s.staffId);
      if (!g.gates.SEPARATION_OF_DUTIES) throw forbidden('SEPARATION_OF_DUTIES');
      await this.stepUp.verify(tx, s.staffId, input.totp, 'reject');
      const now = new Date();
      const appealDeadline = addWorkingDays(now, APPEAL_WINDOW_WORKING_DAYS, holidays);
      await tx.applicationDecision.create({
        data: { cityId: s.cityId, applicationId: app.id, decision: 'REJECTED', reasonCodes: input.reasons, reasonText: input.reasonText, decidedBy: s.staffId, gates: { ...g.gates, ...g.detail } as object },
      });
      await this.transition(tx, app, to, { type: 'STAFF', id: s.staffId }, input.reasonText, { decidedAt: now, appealDeadline: new Date(`${appealDeadline}T00:00:00Z`) });
      // The quota slot stays reserved while an appeal is possible; finalisation releases it.
      await tx.vehicle.update({ where: { id: app.vehicleId! }, data: { status: 'REJECTED_PENDING_APPEAL' } });
      await tx.fitnessInspection.updateMany({ where: { applicationId: app.id, status: 'SCHEDULED' }, data: { status: 'CANCELLED' } });
      await this.audit.record(tx, { cityId: s.cityId, actorType: 'STAFF', actorId: s.staffId, action: 'application.rejected', entityType: 'application', entityId: app.id, data: { applicationNumber: app.applicationNumber, reasons: input.reasons, appealDeadline }, ip });
      const reasons = input.reasons.map((r) => REASON_BN[r] ?? r).join(', ');
      await notifyApplicant(
        tx,
        this.outbox,
        app.applicantUserId,
        `DSCC ই-রিকশা: আবেদন ${app.applicationNumber} না-মঞ্জুর। কারণ: ${reasons}। বিস্তারিত পোর্টালে। ${appealDeadline} তারিখের মধ্যে আপিল করা যাবে (বিধি ৪(৭))।`,
      );
      return { id: app.id, status: to, appealDeadline };
    });
  }

  // ─── Appeals (Rule 4(7)) ───
  async fileAppeal(userId: string, applicationId: string, body: unknown) {
    const input = parseOrThrow(appealSchema, body);
    if (!UUID_RE.test(applicationId)) throw notFound();
    const city = await this.cities.defaultCity();
    return this.prisma.inCity(city.id, async (tx) => {
      await tx.$queryRaw`SELECT id FROM applications WHERE id = ${applicationId}::uuid FOR UPDATE`;
      const app = await tx.application.findFirst({ where: { id: applicationId, applicantUserId: userId, deletedAt: null } });
      if (!app) throw notFound();
      if (app.status !== 'REJECTED' || app.rejectionFinalAt) throw conflict('APPLICATION_INVALID_STATE');
      if (!app.appealDeadline || isoDate(app.appealDeadline)! < dhakaToday()) throw conflict('APPEAL_WINDOW_CLOSED');
      const decision = await tx.applicationDecision.findFirst({ where: { applicationId: app.id, decision: 'REJECTED' }, orderBy: { decidedAt: 'desc' } });
      if (!decision) throw conflict('APPLICATION_INVALID_STATE');
      const existing = await tx.appeal.findUnique({ where: { decisionId: decision.id } });
      if (existing) throw conflict('APPEAL_ALREADY_FILED');
      const appeal = await tx.appeal.create({ data: { cityId: city.id, applicationId: app.id, decisionId: decision.id, filedByUserId: userId, grounds: input.grounds, status: 'PENDING' } });
      await this.audit.record(tx, { cityId: city.id, actorType: 'USER', actorId: userId, action: 'appeal.filed', entityType: 'application', entityId: app.id, data: { appealId: appeal.id } });
      await notifyApplicant(tx, this.outbox, userId, `DSCC ই-রিকশা: আবেদন ${app.applicationNumber}-এর আপিল গৃহীত হয়েছে। ঊর্ধ্বতন কর্তৃপক্ষের সিদ্ধান্ত SMS-এ জানানো হবে।`);
      return { id: appeal.id, status: appeal.status, filedAt: appeal.filedAt };
    });
  }

  async listAppeals(s: StaffContext, status: string | undefined) {
    const scope = zoneFilter(s);
    return this.prisma.inCity(s.cityId, async (tx) => {
      const appeals = await tx.appeal.findMany({ where: status ? { status } : {}, orderBy: { filedAt: 'asc' }, take: 200 });
      const apps = await tx.application.findMany({ where: { id: { in: appeals.map((a) => a.applicationId) } } });
      const amap = new Map(apps.map((a) => [a.id, a]));
      const decisions = await tx.applicationDecision.findMany({ where: { id: { in: appeals.map((a) => a.decisionId) } } });
      const dmap = new Map(decisions.map((d) => [d.id, d]));
      const owners = await tx.ownerIdentity.findMany({ where: { id: { in: apps.map((a) => a.ownerIdentityId) } } });
      const omap = new Map(owners.map((o) => [o.id, o]));
      return appeals
        .filter((a) => {
          const app = amap.get(a.applicationId);
          return app && (!scope || (app.zoneId && scope.includes(app.zoneId)));
        })
        .map((a) => {
          const app = amap.get(a.applicationId)!;
          const d = dmap.get(a.decisionId);
          const o = omap.get(app.ownerIdentityId);
          return {
            id: a.id,
            status: a.status,
            grounds: a.grounds,
            filedAt: a.filedAt,
            decidedAt: a.decidedAt,
            decisionNote: a.decisionNote,
            rejectedByMe: d?.decidedBy === s.staffId,
            application: { id: app.id, applicationNumber: app.applicationNumber, status: app.status },
            owner: o ? { nameBn: o.nameBn, nidMasked: maskNid(o.nidLast4) } : null,
            rejection: d ? { reasons: d.reasonCodes, reasonText: d.reasonText, decidedAt: d.decidedAt } : null,
          };
        });
    });
  }

  async decideAppeal(s: StaffContext, appealId: string, body: unknown, ip: string | null) {
    const input = parseOrThrow(appealDecisionSchema, body);
    if (!UUID_RE.test(appealId)) throw notFound();
    return this.prisma.inCity(s.cityId, async (tx) => {
      await tx.$queryRaw`SELECT id FROM appeals WHERE id = ${appealId}::uuid FOR UPDATE`;
      const appeal = await tx.appeal.findUnique({ where: { id: appealId } });
      if (!appeal) throw notFound();
      const app = await loadStaffApplication(tx, s, appeal.applicationId, true);
      if (appeal.status !== 'PENDING' || app.status !== 'REJECTED') throw conflict('APPEAL_INVALID_STATE');
      const decision = await tx.applicationDecision.findUniqueOrThrow({ where: { id: appeal.decisionId } });
      if (decision.decidedBy === s.staffId) throw forbidden('SEPARATION_OF_DUTIES');
      await this.stepUp.verify(tx, s.staffId, input.totp, 'appeal');
      await tx.appeal.update({ where: { id: appeal.id }, data: { status: input.outcome, decidedBy: s.staffId, decidedAt: new Date(), decisionNote: input.note } });
      if (input.outcome === 'ALLOWED') {
        const to = nextStatus('REJECTED', 'REOPEN_ON_APPEAL')!;
        await this.transition(tx, app, to, { type: 'STAFF', id: s.staffId }, input.note, { appealDeadline: null, decidedAt: null });
        await tx.vehicle.update({ where: { id: app.vehicleId! }, data: { status: 'PENDING_APPROVAL' } });
        await notifyApplicant(tx, this.outbox, app.applicantUserId, `DSCC ই-রিকশা: আবেদন ${app.applicationNumber}-এর আপিল মঞ্জুর হয়েছে। আবেদনটি পুনরায় বিবেচনা করা হবে।`);
      } else {
        await this.finalizeRejection(tx, app, 'APPEAL_DISMISSED', { type: 'STAFF', id: s.staffId });
        await notifyApplicant(tx, this.outbox, app.applicantUserId, `DSCC ই-রিকশা: আবেদন ${app.applicationNumber}-এর আপিল খারিজ হয়েছে। এই সিদ্ধান্ত চূড়ান্ত (বিধি ৪(৭))।`);
      }
      await this.audit.record(tx, { cityId: s.cityId, actorType: 'STAFF', actorId: s.staffId, action: `appeal.${input.outcome.toLowerCase()}`, entityType: 'application', entityId: app.id, data: { appealId: appeal.id }, ip });
      return { id: appeal.id, status: input.outcome };
    });
  }

  private async finalizeRejection(tx: Tx, app: AppRow, reason: string, actor: { type: 'STAFF' | 'SYSTEM'; id: string | null }) {
    await tx.application.update({ where: { id: app.id }, data: { rejectionFinalAt: new Date() } });
    if (app.vehicleId) {
      await tx.vehicle.update({ where: { id: app.vehicleId }, data: { status: 'REJECTED' } });
      await tx.vehicleDriverAssignment.updateMany({ where: { vehicleId: app.vehicleId, validTo: null }, data: { validTo: new Date() } });
      await this.quota.release(tx, { vehicleId: app.vehicleId, cityId: app.cityId, reason: `REJECTION_FINAL_${reason}`, actor });
    }
    await this.audit.record(tx, { cityId: app.cityId, actorType: actor.type, actorId: actor.id, action: 'application.rejection_final', entityType: 'application', entityId: app.id, data: { reason } });
    // DSCC decision, 2026-11-02: when the rejection is final the fees paid are returned.
    await tx.invoice.updateMany({ where: { applicationId: app.id, status: 'UNPAID' }, data: { status: 'CANCELLED' } });
    await this.fees.refundApplication(tx, { cityId: app.cityId, applicationId: app.id, reason: `REJECTION_FINAL_${reason}`, actor });
  }

  /**
   * Close rejected applications whose appeal window has passed without an appeal: the rejection
   * becomes final and the owner's quota slot is released (Phase 0, section 7). Returns the count.
   */
  async finalizeExpiredRejections(today = dhakaToday()): Promise<number> {
    const cities = await this.prisma.city.findMany({ select: { id: true } });
    let n = 0;
    for (const c of cities) {
      n += await this.prisma.inCity(c.id, async (tx) => {
        const due = await tx.application.findMany({
          where: { status: 'REJECTED', rejectionFinalAt: null, appealDeadline: { lt: new Date(`${today}T00:00:00Z`) } },
          take: 200,
        });
        let done = 0;
        for (const app of due) {
          await tx.$queryRaw`SELECT id FROM applications WHERE id = ${app.id}::uuid FOR UPDATE`;
          const open = await tx.appeal.findFirst({ where: { applicationId: app.id, status: { in: ['PENDING', 'ALLOWED'] } } });
          if (open) continue;
          await this.finalizeRejection(tx, app, 'APPEAL_WINDOW_CLOSED', { type: 'SYSTEM', id: null });
          done++;
        }
        return done;
      }, { timeout: 60_000 });
    }
    if (n) this.log.log(`finalised ${n} rejection(s)`);
    return n;
  }

  // ─── Read model for the officer workflow panel ───
  async workflow(s: StaffContext, id: string) {
    return this.prisma.inCity(s.cityId, async (tx) => {
      const app = await loadStaffApplication(tx, s, id);
      const g = await this.computeGates(tx, app, s.staffId);
      const [checks, corrections, inspections, invoice, decisions, appeals, registration] = await Promise.all([
        tx.verificationCheck.findMany({ where: { applicationId: app.id }, orderBy: { createdAt: 'asc' } }),
        tx.correctionRequest.findMany({ where: { applicationId: app.id }, orderBy: { createdAt: 'asc' } }),
        tx.fitnessInspection.findMany({ where: { applicationId: app.id }, orderBy: { createdAt: 'asc' } }),
        tx.invoice.findFirst({ where: { applicationId: app.id, purpose: 'NEW_REGISTRATION', status: { not: 'CANCELLED' } }, include: { payments: { orderBy: { createdAt: 'asc' } } } }),
        tx.applicationDecision.findMany({ where: { applicationId: app.id }, orderBy: { decidedAt: 'asc' } }),
        tx.appeal.findMany({ where: { applicationId: app.id }, orderBy: { filedAt: 'asc' } }),
        tx.registration.findUnique({ where: { applicationId: app.id } }),
      ]);
      const staffIds = [...new Set([...checks.map((c) => c.staffId), ...decisions.map((d) => d.decidedBy), app.verifiedByStaffId].filter((x): x is string => !!x))];
      const staff = await tx.staffAccount.findMany({ where: { id: { in: staffIds } }, select: { id: true, fullName: true } });
      const names = new Map(staff.map((x) => [x.id, x.fullName]));
      const has = (p: string) => s.permissions.has(p);
      return {
        id: app.id,
        status: app.status,
        verifiedBy: app.verifiedByStaffId ? { name: names.get(app.verifiedByStaffId) ?? null, isMe: app.verifiedByStaffId === s.staffId } : null,
        appealDeadline: isoDate(app.appealDeadline),
        rejectionFinal: !!app.rejectionFinalAt,
        gates: APPROVAL_GATES.map((k) => ({ gate: k, ok: g.gates[k] })),
        unmet: g.unmet,
        detail: g.detail,
        checks: checks.map((c) => ({ item: c.item, result: c.result, note: c.note, by: names.get(c.staffId) ?? null, at: c.createdAt })),
        corrections: corrections.map((c) => ({ id: c.id, items: c.items, message: c.message, at: c.createdAt, resolvedAt: c.resolvedAt })),
        inspections: inspections.map((i) => InspectionService.view(i)),
        invoice: invoice ? FeesService.view(invoice, invoice.payments) : null,
        decisions: decisions.map((d) => ({ decision: d.decision, reasons: d.reasonCodes, reasonText: d.reasonText, by: names.get(d.decidedBy) ?? null, at: d.decidedAt })),
        appeals: appeals.map((a) => ({ id: a.id, status: a.status, grounds: a.grounds, filedAt: a.filedAt, decidedAt: a.decidedAt, decisionNote: a.decisionNote })),
        registration: registration ? { id: registration.id, plateSystemId: registration.plateSystemId, plateTextBn: registration.plateTextBn, validUntil: isoDate(registration.validUntil), status: registration.status } : null,
        can: {
          startVerification: has('application.verify') && app.status === 'SUBMITTED',
          check: has('application.verify') && app.status === 'UNDER_VERIFICATION',
          requestCorrection: has('application.verify') && app.status === 'UNDER_VERIFICATION',
          decide: has('application.decide') && app.status === 'UNDER_VERIFICATION' && g.gates.SEPARATION_OF_DUTIES,
          approve: has('application.decide') && g.unmet.length === 0,
        },
      };
    });
  }
}
