import { Controller, Get, Param, Query, Req, Res, UseGuards } from '@nestjs/common';
import { APPLICATION_STATUSES, DECISION_DEADLINE_WORKING_DAYS, maskNid, parseApplicationNumber, workingDaysBetween } from '@dscc/domain';
import { Prisma } from '@prisma/client';
import type { Request, Response } from 'express';
import { z } from 'zod';
import { AuditService } from '../../platform/audit.service';
import { CityService } from '../../platform/city.service';
import { notFound, parseOrThrow } from '../../platform/errors';
import { PrismaService, Tx } from '../../platform/prisma.service';
import { FilesService, contentDisposition } from '../applications/files.service';
import { QuotaService } from '../owners/quota.service';
import { RequirePermissions, Staff, StaffContext, StaffGuard } from '../auth/guards';

const listSchema = z.object({
  status: z.enum(APPLICATION_STATUSES).exclude(['DRAFT']).optional(),
  zoneId: z.string().uuid().optional(),
  wardId: z.string().uuid().optional(),
  q: z.string().trim().max(40).optional(),
  cursor: z.string().max(200).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(25),
});

/** SLA state for the 30-working-day decision deadline. */
export function slaState(elapsed: number): 'ON_TRACK' | 'AT_RISK' | 'OVERDUE' {
  if (elapsed > DECISION_DEADLINE_WORKING_DAYS) return 'OVERDUE';
  if (elapsed >= DECISION_DEADLINE_WORKING_DAYS - 10) return 'AT_RISK';
  return 'ON_TRACK';
}

function encodeCursor(submittedAt: Date, id: string): string {
  return Buffer.from(JSON.stringify([submittedAt.toISOString(), id])).toString('base64url');
}
function decodeCursor(c: string): { submittedAt: Date; id: string } | null {
  try {
    const [t, id] = JSON.parse(Buffer.from(c, 'base64url').toString('utf8'));
    if (typeof t !== 'string' || typeof id !== 'string' || !/^[0-9a-f-]{36}$/.test(id)) return null;
    const d = new Date(t);
    return Number.isNaN(d.getTime()) ? null : { submittedAt: d, id };
  } catch {
    return null;
  }
}

/** Staff assigned only to specific zones see only those zones; a city-wide assignment sees all. */
function zoneFilter(s: StaffContext): string[] | null {
  return s.zoneScopes.includes(null) ? null : (s.zoneScopes as string[]);
}

@Controller('admin/applications')
@UseGuards(StaffGuard)
export class AdminApplicationsController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly cities: CityService,
    private readonly audit: AuditService,
    private readonly files: FilesService,
    private readonly quota: QuotaService,
  ) {}

  @Get()
  @RequirePermissions('application.read')
  async list(@Staff() s: StaffContext, @Query() query: unknown) {
    const q = parseOrThrow(listSchema, query);
    const holidays = await this.cities.holidays();
    const scope = zoneFilter(s);
    return this.prisma.inCity(s.cityId, async (tx) => {
      const where: Prisma.ApplicationWhereInput = { status: q.status ?? { not: 'DRAFT' }, deletedAt: null };
      const and: Prisma.ApplicationWhereInput[] = [];
      if (scope) and.push({ zoneId: { in: scope } });
      if (q.zoneId) and.push({ zoneId: q.zoneId });
      if (q.wardId) and.push({ wardId: q.wardId });
      if (q.q) {
        const parsed = parseApplicationNumber(q.q);
        and.push(parsed ? { applicationNumber: q.q.toUpperCase() } : { applicationNumber: { contains: q.q.toUpperCase() } });
      }
      if (q.cursor) {
        const c = decodeCursor(q.cursor);
        if (c) and.push({ OR: [{ submittedAt: { gt: c.submittedAt } }, { submittedAt: c.submittedAt, id: { gt: c.id } }] });
      }
      if (and.length) where.AND = and;
      const rows = await tx.application.findMany({ where, orderBy: [{ submittedAt: 'asc' }, { id: 'asc' }], take: q.limit + 1 });
      const page = rows.slice(0, q.limit);
      const [zones, wards, owners] = await Promise.all([
        tx.zone.findMany(),
        tx.ward.findMany({ where: { id: { in: page.map((r) => r.wardId).filter((x): x is string => !!x) } } }),
        tx.ownerIdentity.findMany({ where: { id: { in: page.map((r) => r.ownerIdentityId) } } }),
      ]);
      const zmap = new Map(zones.map((z) => [z.id, z]));
      const wmap = new Map(wards.map((w) => [w.id, w]));
      const omap = new Map(owners.map((o) => [o.id, o]));
      const now = new Date();
      const items = page.map((a) => {
        const z = a.zoneId ? zmap.get(a.zoneId) : undefined;
        const w = a.wardId ? wmap.get(a.wardId) : undefined;
        const o = omap.get(a.ownerIdentityId);
        const elapsed = a.submittedAt ? workingDaysBetween(a.submittedAt, now, holidays) : 0;
        const form = a.formData as { vehicle?: { seatType?: string } };
        return {
          id: a.id,
          applicationNumber: a.applicationNumber,
          status: a.status,
          submittedAt: a.submittedAt,
          decisionDueDate: a.decisionDueDate?.toISOString().slice(0, 10) ?? null,
          workingDaysElapsed: elapsed,
          sla: a.status === 'WITHDRAWN' ? null : slaState(elapsed),
          owner: o ? { nameBn: o.nameBn, nidMasked: maskNid(o.nidLast4), verificationStatus: o.verificationStatus } : null,
          zone: z ? { id: z.id, code: z.code, nameBn: z.nameBn, nameEn: z.nameEn, uiColour: z.uiColour } : null,
          ward: w ? { number: w.number, nameBn: w.nameBn, nameEn: w.nameEn } : null,
          seatType: form.vehicle?.seatType ?? null,
        };
      });
      const last = page[page.length - 1];
      return { items, nextCursor: rows.length > q.limit && last?.submittedAt ? encodeCursor(last.submittedAt, last.id) : null };
    });
  }

  @Get('summary')
  @RequirePermissions('application.read')
  async summary(@Staff() s: StaffContext) {
    const scope = zoneFilter(s);
    return this.prisma.inCity(s.cityId, async (tx) => {
      const rows = await tx.application.groupBy({
        by: ['status', 'zoneId'],
        where: { status: { not: 'DRAFT' }, deletedAt: null, ...(scope ? { zoneId: { in: scope } } : {}) },
        _count: { _all: true },
      });
      const zones = await tx.zone.findMany({ orderBy: { code: 'asc' } });
      const byStatus: Record<string, number> = {};
      const byZone: Record<string, number> = {};
      for (const r of rows) {
        byStatus[r.status] = (byStatus[r.status] ?? 0) + r._count._all;
        const code = zones.find((z) => z.id === r.zoneId)?.code ?? '—';
        byZone[code] = (byZone[code] ?? 0) + r._count._all;
      }
      return {
        byStatus,
        byZone: zones.map((z) => ({ code: z.code, nameBn: z.nameBn, nameEn: z.nameEn, uiColour: z.uiColour, count: byZone[z.code] ?? 0 })),
        total: rows.reduce((n, r) => n + r._count._all, 0),
      };
    });
  }

  private async load(tx: Tx, s: StaffContext, id: string) {
    if (!/^[0-9a-f-]{36}$/i.test(id)) throw notFound();
    const scope = zoneFilter(s);
    const app = await tx.application.findFirst({
      where: { id, status: { not: 'DRAFT' }, deletedAt: null, ...(scope ? { zoneId: { in: scope } } : {}) },
    });
    if (!app) throw notFound();
    return app;
  }

  @Get(':id')
  @RequirePermissions('application.read')
  async detail(@Staff() s: StaffContext, @Param('id') id: string, @Req() req: Request) {
    const holidays = await this.cities.holidays();
    return this.prisma.inCity(s.cityId, async (tx) => {
      const app = await this.load(tx, s, id);
      const [owner, applicant, zone, ward, vehicle, docs, events, revisions] = await Promise.all([
        tx.ownerIdentity.findUniqueOrThrow({ where: { id: app.ownerIdentityId } }),
        tx.user.findUniqueOrThrow({ where: { id: app.applicantUserId } }),
        app.zoneId ? tx.zone.findUnique({ where: { id: app.zoneId } }) : null,
        app.wardId ? tx.ward.findUnique({ where: { id: app.wardId } }) : null,
        app.vehicleId ? tx.vehicle.findUnique({ where: { id: app.vehicleId } }) : null,
        tx.applicationDocument.findMany({ where: { applicationId: app.id, supersededAt: null }, include: { file: true }, orderBy: { uploadedAt: 'asc' } }),
        tx.applicationStatusEvent.findMany({ where: { applicationId: app.id }, orderBy: { createdAt: 'asc' } }),
        tx.applicationRevision.count({ where: { applicationId: app.id } }),
      ]);
      const model = vehicle ? await tx.approvedModel.findUnique({ where: { id: vehicle.modelId }, include: { manufacturer: true } }) : null;
      const assignment = vehicle ? await tx.vehicleDriverAssignment.findFirst({ where: { vehicleId: vehicle.id }, orderBy: { validFrom: 'desc' } }) : null;
      const driver = assignment ? await tx.driver.findUnique({ where: { id: assignment.driverId } }) : null;
      const quota = await this.quota.summary(tx, owner.id);
      await this.audit.record(tx, {
        cityId: s.cityId,
        actorType: 'STAFF',
        actorId: s.staffId,
        action: 'admin.application_viewed',
        entityType: 'application',
        entityId: app.id,
        ip: req.ip,
      });
      const elapsed = app.submittedAt ? workingDaysBetween(app.submittedAt, new Date(), holidays) : 0;
      return {
        id: app.id,
        applicationNumber: app.applicationNumber,
        status: app.status,
        submittedAt: app.submittedAt,
        withdrawnAt: app.withdrawnAt,
        decisionDueDate: app.decisionDueDate?.toISOString().slice(0, 10) ?? null,
        workingDaysElapsed: elapsed,
        sla: app.status === 'WITHDRAWN' ? null : slaState(elapsed),
        applicantPhone: applicant.phoneE164,
        owner: {
          nameBn: owner.nameBn,
          nameEn: owner.nameEn,
          nidMasked: maskNid(owner.nidLast4),
          nidKind: owner.nidKind,
          dateOfBirth: owner.dateOfBirth.toISOString().slice(0, 10),
          fatherNameBn: owner.fatherNameBn,
          motherNameBn: owner.motherNameBn,
          presentAddress: owner.presentAddress,
          permanentAddress: owner.permanentAddress,
          education: owner.education,
          verificationStatus: owner.verificationStatus,
          quota,
        },
        vehicle: vehicle
          ? {
              seatType: vehicle.seatType,
              manufacturer: model?.manufacturer.nameBn ?? null,
              model: model?.name ?? null,
              manufactureYear: vehicle.manufactureYear,
              chassisNo: vehicle.chassisNo,
              motorNo: vehicle.motorNo,
              batteryType: vehicle.batteryType,
              hasSpeedometer: vehicle.hasSpeedometer,
              insurancePolicyNo: vehicle.insurancePolicyNo,
              colour: vehicle.colour,
              chargingLocation: vehicle.chargingLocation,
              status: vehicle.status,
            }
          : null,
        zone: zone ? { code: zone.code, nameBn: zone.nameBn, nameEn: zone.nameEn, uiColour: zone.uiColour } : null,
        ward: ward ? { number: ward.number, nameBn: ward.nameBn, nameEn: ward.nameEn } : null,
        driver: driver
          ? {
              nameBn: driver.nameBn,
              nameEn: driver.nameEn,
              nidMasked: maskNid(driver.nidLast4),
              dateOfBirth: driver.dateOfBirth.toISOString().slice(0, 10),
              phone: driver.phoneE164,
              address: driver.address,
              trainingCertificateNo: driver.trainingCertificateNo,
            }
          : null,
        documents: docs.map((d) => ({
          id: d.id,
          docType: d.docType,
          mimeType: d.file.mimeType,
          sizeBytes: d.file.sizeBytes,
          sha256: d.file.sha256,
          uploadedAt: d.uploadedAt,
        })),
        timeline: events.map((e) => ({ fromStatus: e.fromStatus, toStatus: e.toStatus, actorType: e.actorType, note: e.note, at: e.createdAt })),
        revisions,
      };
    });
  }

  @Get(':id/documents/:docId/file')
  @RequirePermissions('application.read')
  async document(@Staff() s: StaffContext, @Param('id') id: string, @Param('docId') docId: string, @Req() req: Request, @Res() res: Response) {
    const file = await this.prisma.inCity(s.cityId, async (tx) => {
      const app = await this.load(tx, s, id);
      if (!/^[0-9a-f-]{36}$/i.test(docId)) throw notFound();
      const doc = await tx.applicationDocument.findFirst({ where: { id: docId, applicationId: app.id }, include: { file: true } });
      if (!doc) throw notFound();
      await this.audit.record(tx, {
        cityId: s.cityId,
        actorType: 'STAFF',
        actorId: s.staffId,
        action: 'admin.document_viewed',
        entityType: 'application',
        entityId: app.id,
        data: { docType: doc.docType },
        ip: req.ip,
      });
      return doc.file;
    });
    const data = await this.files.read(file.storageKey);
    res.setHeader('Content-Type', file.mimeType);
    res.setHeader('Content-Disposition', contentDisposition(file.originalName, file.mimeType));
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Cache-Control', 'private, no-store');
    res.send(data);
  }
}
