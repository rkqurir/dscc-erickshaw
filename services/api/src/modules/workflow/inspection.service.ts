import { Inject, Injectable } from '@nestjs/common';
import { FITNESS_ITEMS, FitnessItem, formatSerial, inspectionPassed, inspectionResultSchema, inspectionScheduleSchema, periodEndIso } from '@dscc/domain';
import { AppConfig, CONFIG } from '../../config';
import { AuditService } from '../../platform/audit.service';
import { CityService } from '../../platform/city.service';
import { badRequest, conflict, forbidden, notFound, parseOrThrow } from '../../platform/errors';
import { OutboxService } from '../../platform/outbox.service';
import { PrismaService, Tx } from '../../platform/prisma.service';
import { nextSerial } from '../../platform/serials';
import { StaffContext } from '../auth/guards';
import { UUID_RE, dhakaToday, isoDate, loadStaffApplication, notifyApplicant, zoneFilter } from './scope';

type InspectionRow = Awaited<ReturnType<Tx['fitnessInspection']['findFirstOrThrow']>>;

/**
 * Fitness inspection (Rule 4(2)(d), 4(11), Schedule 4): appointment → inspection against the
 * Schedule 4 checklist by an inspecting officer → countersignature by a different (traffic) officer →
 * certificate number and validity. A failed inspection can be followed by a new appointment.
 */
@Injectable()
export class InspectionService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly cities: CityService,
    private readonly audit: AuditService,
    private readonly outbox: OutboxService,
    @Inject(CONFIG) private readonly config: AppConfig,
  ) {}

  static view(i: InspectionRow) {
    return {
      id: i.id,
      status: i.status,
      scheduledFor: i.scheduledFor,
      location: i.location,
      checklist: i.checklist as Record<FitnessItem, 'PASS' | 'FAIL'> | null,
      inspectedAt: i.inspectedAt,
      inspectorNote: i.inspectorNote,
      countersigned: !!i.countersignedBy,
      countersignedAt: i.countersignedAt,
      certificateNo: i.certificateNo,
      validUntil: isoDate(i.validUntil),
    };
  }

  /** The current valid certificate for an application (passed, countersigned, not expired), if any. */
  static async validCertificate(tx: Tx, applicationId: string, today = dhakaToday()) {
    const rows = await tx.fitnessInspection.findMany({
      where: { applicationId, status: 'PASSED', certificateNo: { not: null } },
      orderBy: { countersignedAt: 'desc' },
    });
    return rows.find((r) => r.validUntil && isoDate(r.validUntil)! >= today) ?? null;
  }

  async schedule(s: StaffContext, applicationId: string, body: unknown) {
    const input = parseOrThrow(inspectionScheduleSchema, body);
    if (input.scheduledFor.getTime() < Date.now() - 60_000) throw badRequest('VALIDATION_FAILED', { fields: { scheduledFor: 'DATE_INVALID' } });
    return this.prisma.inCity(s.cityId, async (tx) => {
      const app = await loadStaffApplication(tx, s, applicationId, true);
      if (!['SUBMITTED', 'UNDER_VERIFICATION'].includes(app.status) || !app.vehicleId) throw conflict('APPLICATION_INVALID_STATE');
      const open = await tx.fitnessInspection.findFirst({ where: { applicationId: app.id, status: 'SCHEDULED' } });
      if (open) throw conflict('INSPECTION_ALREADY_SCHEDULED');
      if (await InspectionService.validCertificate(tx, app.id)) throw conflict('FITNESS_ALREADY_CERTIFIED');
      const row = await tx.fitnessInspection.create({
        data: { cityId: s.cityId, applicationId: app.id, vehicleId: app.vehicleId, status: 'SCHEDULED', scheduledFor: input.scheduledFor, location: input.location, scheduledBy: s.staffId },
      });
      await this.audit.record(tx, { cityId: s.cityId, actorType: 'STAFF', actorId: s.staffId, action: 'inspection.scheduled', entityType: 'application', entityId: app.id, data: { inspectionId: row.id, scheduledFor: input.scheduledFor.toISOString() } });
      const when = new Intl.DateTimeFormat('bn-BD', { timeZone: 'Asia/Dhaka', dateStyle: 'long', timeStyle: 'short' }).format(input.scheduledFor);
      await notifyApplicant(tx, this.outbox, app.applicantUserId, `DSCC ই-রিকশা: আবেদন ${app.applicationNumber}-এর ফিটনেস পরিদর্শন ${when}, স্থান: ${input.location}। গাড়িসহ উপস্থিত থাকুন।`);
      return InspectionService.view(row);
    });
  }

  async list(s: StaffContext, status: string | undefined) {
    const scope = zoneFilter(s);
    return this.prisma.inCity(s.cityId, async (tx) => {
      const rows = await tx.fitnessInspection.findMany({
        where: status ? { status } : {},
        orderBy: { scheduledFor: 'asc' },
        take: 200,
      });
      const apps = await tx.application.findMany({ where: { id: { in: rows.map((r) => r.applicationId) } } });
      const amap = new Map(apps.map((a) => [a.id, a]));
      const vehicles = await tx.vehicle.findMany({ where: { id: { in: rows.map((r) => r.vehicleId) } } });
      const vmap = new Map(vehicles.map((v) => [v.id, v]));
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
          const v = vmap.get(r.vehicleId);
          const z = a.zoneId ? zmap.get(a.zoneId) : undefined;
          const m = v ? mmap.get(v.modelId) : undefined;
          return {
            ...InspectionService.view(r),
            inspectedByMe: r.inspectorStaffId === s.staffId,
            application: { id: a.id, applicationNumber: a.applicationNumber, status: a.status },
            vehicle: v ? { seatType: v.seatType, chassisNo: v.chassisNo, motorNo: v.motorNo, model: m ? `${m.manufacturer.nameBn} ${m.name}` : null, hasSpeedometer: v.hasSpeedometer } : null,
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
    await loadStaffApplication(tx, s, row.applicationId); // zone scope
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
        await notifyApplicant(tx, this.outbox, app.applicantUserId, `DSCC ই-রিকশা: আবেদন ${app.applicationNumber}-এর ফিটনেস পরিদর্শনে ${failed}টি বিষয় উত্তীর্ণ হয়নি। মেরামতের পর পুনঃপরিদর্শনের তারিখ জানানো হবে।`);
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
      await notifyApplicant(tx, this.outbox, app.applicantUserId, `DSCC ই-রিকশা: আবেদন ${app.applicationNumber}-এর ফিটনেস সনদ ${certificateNo} ইস্যু হয়েছে, মেয়াদ ${validUntil} পর্যন্ত।`);
      return InspectionService.view(upd);
    });
  }

  async cancel(s: StaffContext, id: string) {
    return this.prisma.inCity(s.cityId, async (tx) => {
      const row = await this.loadInspection(tx, s, id);
      if (row.status !== 'SCHEDULED') throw conflict('INSPECTION_INVALID_STATE');
      const upd = await tx.fitnessInspection.update({ where: { id: row.id }, data: { status: 'CANCELLED', version: { increment: 1 } } });
      await this.audit.record(tx, { cityId: s.cityId, actorType: 'STAFF', actorId: s.staffId, action: 'inspection.cancelled', entityType: 'application', entityId: row.applicationId, data: { inspectionId: row.id } });
      return InspectionService.view(upd);
    });
  }
}
