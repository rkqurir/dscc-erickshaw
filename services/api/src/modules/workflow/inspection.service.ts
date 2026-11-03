import { Inject, Injectable } from '@nestjs/common';
import {
  FITNESS_ITEMS,
  FITNESS_REQUEST_STATUSES,
  FitnessItem,
  formatSerial,
  inspectionPassed,
  inspectionResultSchema,
  inspectionScheduleSchema,
  periodEndIso,
  vehicleSectionSchema,
} from '@dscc/domain';
import { AppConfig, CONFIG } from '../../config';
import { AuditService } from '../../platform/audit.service';
import { CityService } from '../../platform/city.service';
import { AppError, badRequest, conflict, forbidden, notFound, parseOrThrow, validationError } from '../../platform/errors';
import { OutboxService } from '../../platform/outbox.service';
import { PrismaService, Tx } from '../../platform/prisma.service';
import { nextSerial } from '../../platform/serials';
import { StaffContext } from '../auth/guards';
import { FeesService, applicationLabel } from './fees.service';
import { UUID_RE, dhakaToday, isoDate, loadStaffApplication, notifyApplicant, zoneFilter } from './scope';

type InspectionRow = Awaited<ReturnType<Tx['fitnessInspection']['findFirstOrThrow']>>;

/** The part of the vehicle section an inspection is bound to. */
const fitnessVehicleSchema = vehicleSectionSchema.pick({ seatType: true, modelId: true, chassisNo: true, motorNo: true });

/**
 * Fitness inspection (Rule 4(2)(d), 4(11), Schedule 4): citizen request from the draft and fee payment →
 * appointment → inspection against the
 * Schedule 4 checklist by an inspecting officer → countersignature by a different (traffic) officer →
 * certificate number and validity. A failed inspection can be followed by a new request. The certificate
 * must exist before the application is submitted (DSCC decision, 2026-11-02).
 */
@Injectable()
export class InspectionService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly cities: CityService,
    private readonly audit: AuditService,
    private readonly outbox: OutboxService,
    private readonly fees: FeesService,
    @Inject(CONFIG) private readonly config: AppConfig,
  ) {}

  static view(i: InspectionRow, invoice?: { id: string; invoiceNo: string; status: string; totalBdt: number } | null) {
    return {
      id: i.id,
      status: i.status,
      chassisNo: i.chassisNo,
      motorNo: i.motorNo,
      seatType: i.seatType,
      requestedAt: i.requestedAt,
      scheduledFor: i.scheduledFor,
      location: i.location,
      checklist: i.checklist as Record<FitnessItem, 'PASS' | 'FAIL'> | null,
      inspectedAt: i.inspectedAt,
      inspectorNote: i.inspectorNote,
      countersigned: !!i.countersignedBy,
      countersignedAt: i.countersignedAt,
      certificateNo: i.certificateNo,
      validUntil: isoDate(i.validUntil),
      ...(invoice !== undefined ? { invoice: invoice ? { id: invoice.id, invoiceNo: invoice.invoiceNo, status: invoice.status, totalBdt: invoice.totalBdt } : null } : {}),
    };
  }

  /**
   * The current valid certificate for an application (passed, countersigned, not expired), if any.
   * With `vehicle`, the certificate must also be for that chassis and motor: a certificate is for the
   * rickshaw that was inspected, not for whatever the form says later.
   */
  static async validCertificate(tx: Tx, applicationId: string, today = dhakaToday(), vehicle?: { chassisNo: string; motorNo: string }) {
    const rows = await tx.fitnessInspection.findMany({
      where: { applicationId, status: 'PASSED', certificateNo: { not: null }, ...(vehicle ? { chassisNo: vehicle.chassisNo, motorNo: vehicle.motorNo } : {}) },
      orderBy: { countersignedAt: 'desc' },
    });
    return rows.find((r) => r.validUntil && isoDate(r.validUntil)! >= today) ?? null;
  }

  /** An open request or appointment, which blocks a second request and locks the vehicle fields. */
  static openInspection(tx: Tx, applicationId: string) {
    return tx.fitnessInspection.findFirst({ where: { applicationId, status: { in: ['REQUESTED', 'SCHEDULED'] } } });
  }

  /**
   * Citizen: request a fitness inspection for the rickshaw described in the application (DSCC decision,
   * 2026-11-02: the certificate is needed before the application can be submitted). Creates the fitness fee
   * invoice; an officer gives the appointment once it is paid.
   */
  async request(userId: string, applicationId: string) {
    const city = await this.cities.defaultCity();
    return this.prisma.inCity(city.id, async (tx) => {
      if (!UUID_RE.test(applicationId)) throw notFound();
      await tx.$queryRaw`SELECT id FROM applications WHERE id = ${applicationId}::uuid FOR UPDATE`;
      const app = await tx.application.findFirst({ where: { id: applicationId, applicantUserId: userId, deletedAt: null } });
      if (!app) throw notFound();
      if (!FITNESS_REQUEST_STATUSES.has(app.status)) throw conflict('APPLICATION_INVALID_STATE');
      const form = app.formData as { vehicle?: unknown; location?: { zoneId?: unknown } };
      const v = fitnessVehicleSchema.safeParse(form.vehicle ?? {});
      if (!v.success) {
        const e = validationError(v.error);
        const fields = Object.fromEntries(Object.entries((e.details as { fields?: Record<string, string> })?.fields ?? {}).map(([k, val]) => [`vehicle.${k}`, val]));
        throw new AppError('FITNESS_VEHICLE_INCOMPLETE', 400, { fields });
      }
      const zoneId = app.zoneId ?? (typeof form.location?.zoneId === 'string' ? form.location.zoneId : null);
      if (!zoneId || !UUID_RE.test(zoneId) || !(await tx.zone.findUnique({ where: { id: zoneId } }))) {
        throw new AppError('FITNESS_VEHICLE_INCOMPLETE', 400, { fields: { 'location.zoneId': 'REQUIRED' } });
      }
      const model = await tx.approvedModel.findUnique({ where: { id: v.data.modelId } });
      if (!model || !model.isActive) throw badRequest('VALIDATION_FAILED', { fields: { 'vehicle.modelId': 'REQUIRED' } });
      if (model.seatType !== v.data.seatType) throw badRequest('MODEL_SEAT_MISMATCH');
      const live = await tx.vehicle.findFirst({
        where: {
          OR: [{ chassisNo: v.data.chassisNo }, { motorNo: v.data.motorNo }],
          status: { notIn: ['WITHDRAWN', 'REJECTED'] },
          ...(app.vehicleId ? { id: { not: app.vehicleId } } : {}),
        },
        select: { chassisNo: true },
      });
      if (live) throw conflict(live.chassisNo === v.data.chassisNo ? 'CHASSIS_ALREADY_REGISTERED' : 'MOTOR_ALREADY_REGISTERED');
      if (await InspectionService.openInspection(tx, app.id)) throw conflict('INSPECTION_ALREADY_SCHEDULED');
      if (await InspectionService.validCertificate(tx, app.id, dhakaToday(), v.data)) throw conflict('FITNESS_ALREADY_CERTIFIED');

      if (app.status === 'DRAFT' && !app.zoneId) await tx.application.update({ where: { id: app.id }, data: { zoneId } });
      const invoice = await this.fees.createFitnessInvoice(tx, { cityId: city.id, cityCode: city.code, applicationId: app.id, seatType: v.data.seatType });
      const row = await tx.fitnessInspection.create({
        data: {
          cityId: city.id,
          applicationId: app.id,
          vehicleId: app.vehicleId,
          chassisNo: v.data.chassisNo,
          motorNo: v.data.motorNo,
          seatType: v.data.seatType,
          modelId: model.id,
          invoiceId: invoice.id,
          status: 'REQUESTED',
        },
      });
      await this.audit.record(tx, { cityId: city.id, actorType: 'USER', actorId: userId, action: 'inspection.requested', entityType: 'application', entityId: app.id, data: { inspectionId: row.id, chassisNo: row.chassisNo, invoiceNo: invoice.invoiceNo } });
      return InspectionService.view(row, invoice);
    });
  }

  /** Citizen: withdraw a request that has not been paid yet (e.g. to correct a chassis number). */
  async cancelRequest(userId: string, applicationId: string) {
    const city = await this.cities.defaultCity();
    return this.prisma.inCity(city.id, async (tx) => {
      if (!UUID_RE.test(applicationId)) throw notFound();
      await tx.$queryRaw`SELECT id FROM applications WHERE id = ${applicationId}::uuid FOR UPDATE`;
      const app = await tx.application.findFirst({ where: { id: applicationId, applicantUserId: userId, deletedAt: null } });
      if (!app) throw notFound();
      const open = await InspectionService.openInspection(tx, app.id);
      if (!open || open.status !== 'REQUESTED') throw conflict('INSPECTION_INVALID_STATE');
      const inv = open.invoiceId ? await tx.invoice.findUnique({ where: { id: open.invoiceId } }) : null;
      if (inv && inv.status !== 'UNPAID') throw conflict('FITNESS_FEE_ALREADY_PAID');
      if (inv) await tx.invoice.update({ where: { id: inv.id }, data: { status: 'CANCELLED' } });
      const upd = await tx.fitnessInspection.update({ where: { id: open.id }, data: { status: 'CANCELLED', version: { increment: 1 } } });
      await this.audit.record(tx, { cityId: city.id, actorType: 'USER', actorId: userId, action: 'inspection.request_cancelled', entityType: 'application', entityId: app.id, data: { inspectionId: open.id } });
      return InspectionService.view(upd, inv ? { ...inv, status: 'CANCELLED' } : null);
    });
  }

  /** Officer: give a paid request its appointment (or a new one after the previous was cancelled). */
  async schedule(s: StaffContext, id: string, body: unknown) {
    const input = parseOrThrow(inspectionScheduleSchema, body);
    if (input.scheduledFor.getTime() < Date.now() - 60_000) throw badRequest('VALIDATION_FAILED', { fields: { scheduledFor: 'DATE_INVALID' } });
    return this.prisma.inCity(s.cityId, async (tx) => {
      const row = await this.loadInspection(tx, s, id);
      if (row.status !== 'REQUESTED') throw conflict('INSPECTION_INVALID_STATE');
      const inv = row.invoiceId ? await tx.invoice.findUnique({ where: { id: row.invoiceId } }) : null;
      if (inv && inv.status !== 'PAID') throw conflict('FITNESS_FEE_UNPAID');
      const app = await tx.application.findUniqueOrThrow({ where: { id: row.applicationId } });
      if (!FITNESS_REQUEST_STATUSES.has(app.status)) throw conflict('APPLICATION_INVALID_STATE');
      const upd = await tx.fitnessInspection.update({
        where: { id: row.id },
        data: { status: 'SCHEDULED', scheduledFor: input.scheduledFor, location: input.location, scheduledBy: s.staffId, version: { increment: 1 } },
      });
      await this.audit.record(tx, { cityId: s.cityId, actorType: 'STAFF', actorId: s.staffId, action: 'inspection.scheduled', entityType: 'application', entityId: app.id, data: { inspectionId: row.id, scheduledFor: input.scheduledFor.toISOString() } });
      const when = new Intl.DateTimeFormat('bn-BD', { timeZone: 'Asia/Dhaka', dateStyle: 'long', timeStyle: 'short' }).format(input.scheduledFor);
      await notifyApplicant(tx, this.outbox, app.applicantUserId, `DSCC ই-রিকশা: ${applicationLabel(app)}-এর ফিটনেস পরিদর্শন ${when}, স্থান: ${input.location}। গাড়িসহ উপস্থিত থাকুন।`);
      return InspectionService.view(upd, inv);
    });
  }

  async list(s: StaffContext, status: string | undefined) {
    const scope = zoneFilter(s);
    return this.prisma.inCity(s.cityId, async (tx) => {
      const rows = await tx.fitnessInspection.findMany({
        where: status ? { status } : {},
        orderBy: [{ scheduledFor: 'asc' }, { requestedAt: 'asc' }],
        take: 200,
      });
      const apps = await tx.application.findMany({ where: { id: { in: rows.map((r) => r.applicationId) }, deletedAt: null } });
      const amap = new Map(apps.map((a) => [a.id, a]));
      const invoices = await tx.invoice.findMany({ where: { id: { in: rows.map((r) => r.invoiceId).filter((x): x is string => !!x) } } });
      const imap = new Map(invoices.map((i) => [i.id, i]));
      const zones = await tx.zone.findMany();
      const zmap = new Map(zones.map((z) => [z.id, z]));
      const models = await tx.approvedModel.findMany({ include: { manufacturer: true } });
      const mmap = new Map(models.map((m) => [m.id, m]));
      return rows
        .filter((r) => {
          const a = amap.get(r.applicationId);
          return a && (!scope || (a.zoneId && scope.includes(a.zoneId)));
        })
        .map((r) => {
          const a = amap.get(r.applicationId)!;
          const z = a.zoneId ? zmap.get(a.zoneId) : undefined;
          const m = mmap.get(r.modelId);
          const f = a.formData as { vehicle?: { hasSpeedometer?: unknown } };
          return {
            ...InspectionService.view(r, r.invoiceId ? (imap.get(r.invoiceId) ?? null) : null),
            inspectedByMe: r.inspectorStaffId === s.staffId,
            application: { id: a.id, applicationNumber: a.applicationNumber, status: a.status },
            vehicle: {
              seatType: r.seatType,
              chassisNo: r.chassisNo,
              motorNo: r.motorNo,
              model: m ? `${m.manufacturer.nameBn} ${m.name}` : null,
              hasSpeedometer: typeof f.vehicle?.hasSpeedometer === 'boolean' ? f.vehicle.hasSpeedometer : null,
            },
            zone: z ? { code: z.code, nameBn: z.nameBn, nameEn: z.nameEn, uiColour: z.uiColour } : null,
          };
        });
    });
  }

  private async loadInspection(tx: Tx, s: StaffContext, id: string) {
    if (!UUID_RE.test(id)) throw notFound();
    await tx.$queryRaw`SELECT id FROM fitness_inspections WHERE id = ${id}::uuid FOR UPDATE`;
    const row = await tx.fitnessInspection.findUnique({ where: { id } });
    if (!row) throw notFound();
    await loadStaffApplication(tx, s, row.applicationId, false, true); // zone scope; drafts included
    return row;
  }

  async recordResult(s: StaffContext, id: string, body: unknown) {
    const input = parseOrThrow(inspectionResultSchema, body);
    return this.prisma.inCity(s.cityId, async (tx) => {
      const row = await this.loadInspection(tx, s, id);
      if (row.status !== 'SCHEDULED') throw conflict('INSPECTION_INVALID_STATE');
      const passed = inspectionPassed(input.checklist);
      const upd = await tx.fitnessInspection.update({
        where: { id: row.id },
        data: {
          status: passed ? 'PASSED' : 'FAILED',
          checklist: input.checklist,
          inspectorStaffId: s.staffId,
          inspectedAt: new Date(),
          inspectorNote: input.note ?? null,
          version: { increment: 1 },
        },
      });
      const app = await tx.application.findUniqueOrThrow({ where: { id: row.applicationId } });
      await this.audit.record(tx, { cityId: s.cityId, actorType: 'STAFF', actorId: s.staffId, action: passed ? 'inspection.passed' : 'inspection.failed', entityType: 'application', entityId: app.id, data: { inspectionId: row.id, checklist: input.checklist } });
      if (!passed) {
        const failed = FITNESS_ITEMS.filter((i) => input.checklist[i] === 'FAIL').length;
        await notifyApplicant(tx, this.outbox, app.applicantUserId, `DSCC ই-রিকশা: ${applicationLabel(app)}-এর ফিটনেস পরিদর্শনে ${failed}টি বিষয় উত্তীর্ণ হয়নি। মেরামতের পর আবার পরিদর্শনের আবেদন করুন।`);
      }
      return InspectionService.view(upd);
    });
  }

  /** Traffic countersignature issues the certificate number; the countersigner must not be the inspector. */
  async countersign(s: StaffContext, id: string) {
    const city = await this.cities.byId(s.cityId);
    return this.prisma.inCity(s.cityId, async (tx) => {
      const row = await this.loadInspection(tx, s, id);
      if (row.status !== 'PASSED' || row.countersignedBy) throw conflict('INSPECTION_INVALID_STATE');
      if (row.inspectorStaffId === s.staffId) throw forbidden('SEPARATION_OF_DUTIES');
      const today = dhakaToday();
      const year = Number(today.slice(0, 4));
      const certificateNo = formatSerial('FIT', city.code, year, await nextSerial(tx, s.cityId, 'FITNESS', String(year)));
      const validUntil = periodEndIso(today, this.config.FITNESS_VALIDITY_MONTHS);
      const upd = await tx.fitnessInspection.update({
        where: { id: row.id },
        data: { countersignedBy: s.staffId, countersignedAt: new Date(), certificateNo, validUntil: new Date(`${validUntil}T00:00:00Z`), version: { increment: 1 } },
      });
      const app = await tx.application.findUniqueOrThrow({ where: { id: row.applicationId } });
      await this.audit.record(tx, { cityId: s.cityId, actorType: 'STAFF', actorId: s.staffId, action: 'inspection.countersigned', entityType: 'application', entityId: app.id, data: { inspectionId: row.id, certificateNo, validUntil } });
      await notifyApplicant(tx, this.outbox, app.applicantUserId, `DSCC ই-রিকশা: ${applicationLabel(app)}-এর ফিটনেস সনদ ${certificateNo} ইস্যু হয়েছে, মেয়াদ ${validUntil} পর্যন্ত।${app.status === 'DRAFT' ? ' এখন আবেদন জমা দিতে পারবেন।' : ''}`);
      return InspectionService.view(upd);
    });
  }

  /**
   * Officer: cancel an appointment (e.g. the rickshaw was not brought). The paid request goes back to
   * the queue for a new appointment, so the applicant does not pay twice.
   */
  async cancel(s: StaffContext, id: string) {
    return this.prisma.inCity(s.cityId, async (tx) => {
      const row = await this.loadInspection(tx, s, id);
      if (row.status !== 'SCHEDULED') throw conflict('INSPECTION_INVALID_STATE');
      const upd = await tx.fitnessInspection.update({
        where: { id: row.id },
        data: { status: 'REQUESTED', scheduledFor: null, location: null, scheduledBy: null, version: { increment: 1 } },
      });
      await this.audit.record(tx, { cityId: s.cityId, actorType: 'STAFF', actorId: s.staffId, action: 'inspection.appointment_cancelled', entityType: 'application', entityId: row.applicationId, data: { inspectionId: row.id } });
      const app = await tx.application.findUniqueOrThrow({ where: { id: row.applicationId } });
      await notifyApplicant(tx, this.outbox, app.applicantUserId, `DSCC ই-রিকশা: ${applicationLabel(app)}-এর ফিটনেস পরিদর্শনের সময় বাতিল হয়েছে। নতুন সময় জানানো হবে।`);
      return InspectionService.view(upd);
    });
  }
}
