import { Body, Controller, Get, Param, Patch, Req, UseGuards } from '@nestjs/common';
import { contrastRatio, formatPlateBengali, formatPlateSystemId, whiteTextContrastOk, zoneUpdateSchema } from '@dscc/domain';
import type { Request } from 'express';
import { z } from 'zod';
import { AuditService } from '../../platform/audit.service';
import { CityService } from '../../platform/city.service';
import { conflict, notFound, parseOrThrow } from '../../platform/errors';
import { PrismaService } from '../../platform/prisma.service';
import { RequirePermissions, Staff, StaffContext, StaffGuard } from '../auth/guards';

type ZoneRow = {
  id: string;
  code: string;
  nameBn: string;
  nameEn: string;
  uiColour: string;
  plateBackgroundColour: string;
  plateAreaCodeBn: string;
  vehicleQuota: number | null;
  approvalStatus: string;
  version: number;
  updatedAt: Date;
};

const SAMPLE_SERIAL = 2324;

/** Zones Z1–Z4. Colours, plate codes and quotas are proposals until DSCC + traffic approve (Rule 9(3)). */
@Controller('admin/zones')
@UseGuards(StaffGuard)
export class AdminZonesController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly cities: CityService,
    private readonly audit: AuditService,
  ) {}

  private async present(cityId: string, z: ZoneRow, wardCount: number) {
    const city = await this.cities.byId(cityId);
    return {
      id: z.id,
      code: z.code,
      nameBn: z.nameBn,
      nameEn: z.nameEn,
      uiColour: z.uiColour,
      plateBackgroundColour: z.plateBackgroundColour,
      plateAreaCodeBn: z.plateAreaCodeBn,
      vehicleQuota: z.vehicleQuota,
      approvalStatus: z.approvalStatus,
      version: z.version,
      updatedAt: z.updatedAt,
      wardCount,
      plateContrast: Math.round(contrastRatio('#FFFFFF', z.plateBackgroundColour) * 100) / 100,
      plateContrastOk: whiteTextContrastOk(z.plateBackgroundColour),
      examples: {
        systemId: formatPlateSystemId(city.code, z.code, SAMPLE_SERIAL),
        plateBn: formatPlateBengali(city.plateCityNameBn, z.plateAreaCodeBn, SAMPLE_SERIAL),
      },
    };
  }

  @Get()
  @RequirePermissions('zone.read')
  async list(@Staff() s: StaffContext) {
    const rows = await this.prisma.inCity(s.cityId, async (tx) => {
      const zones = await tx.zone.findMany({ orderBy: { code: 'asc' }, include: { _count: { select: { wards: true } } } });
      return zones;
    });
    return Promise.all(rows.map((z) => this.present(s.cityId, z, z._count.wards)));
  }

  @Get(':id/versions')
  @RequirePermissions('zone.read')
  async versions(@Staff() s: StaffContext, @Param('id') id: string) {
    if (!/^[0-9a-f-]{36}$/i.test(id)) throw notFound();
    return this.prisma.inCity(s.cityId, async (tx) => {
      const zone = await tx.zone.findUnique({ where: { id } });
      if (!zone) throw notFound();
      const vs = await tx.zoneVersion.findMany({ where: { zoneId: id }, orderBy: { version: 'desc' } });
      const staffIds = [...new Set(vs.map((v) => v.changedBy).filter((x): x is string => !!x))];
      const staff = await tx.staffAccount.findMany({ where: { id: { in: staffIds } }, select: { id: true, fullName: true } });
      const names = new Map(staff.map((x) => [x.id, x.fullName]));
      return vs.map((v) => ({
        version: v.version,
        snapshot: v.snapshot,
        changeNote: v.changeNote,
        changedBy: v.changedBy ? names.get(v.changedBy) ?? null : null,
        changedAt: v.changedAt,
      }));
    });
  }

  @Patch(':id')
  @RequirePermissions('zone.manage')
  async update(@Staff() s: StaffContext, @Param('id') id: string, @Body() body: unknown, @Req() req: Request) {
    if (!/^[0-9a-f-]{36}$/i.test(id)) throw notFound();
    const input = parseOrThrow(zoneUpdateSchema, body);
    const { version } = parseOrThrow(z.object({ version: z.number().int() }), body);
    const result = await this.prisma.inCity(s.cityId, async (tx) => {
      const zone = await tx.zone.findUnique({ where: { id } });
      if (!zone) throw notFound();
      const clash = await tx.zone.findFirst({ where: { plateAreaCodeBn: input.plateAreaCodeBn, id: { not: id } } });
      if (clash) throw conflict('ZONE_PLATE_CODE_TAKEN');
      const data = {
        nameBn: input.nameBn,
        nameEn: input.nameEn,
        uiColour: input.uiColour.toUpperCase(),
        plateBackgroundColour: input.plateBackgroundColour.toUpperCase(),
        plateAreaCodeBn: input.plateAreaCodeBn,
        vehicleQuota: input.vehicleQuota,
        approvalStatus: input.approvalStatus,
      };
      const upd = await tx.zone.updateMany({
        where: { id, version },
        data: { ...data, version: { increment: 1 }, updatedByStaffId: s.staffId },
      });
      if (upd.count !== 1) throw conflict('CONFLICT');
      const after = await tx.zone.findUniqueOrThrow({ where: { id }, include: { _count: { select: { wards: true } } } });
      await tx.zoneVersion.create({
        data: { zoneId: id, cityId: s.cityId, version: after.version, snapshot: { code: after.code, ...data }, changeNote: input.changeNote, changedBy: s.staffId },
      });
      const before = {
        nameBn: zone.nameBn,
        nameEn: zone.nameEn,
        uiColour: zone.uiColour,
        plateBackgroundColour: zone.plateBackgroundColour,
        plateAreaCodeBn: zone.plateAreaCodeBn,
        vehicleQuota: zone.vehicleQuota,
        approvalStatus: zone.approvalStatus,
      };
      await this.audit.record(tx, {
        cityId: s.cityId,
        actorType: 'STAFF',
        actorId: s.staffId,
        action: 'zone.updated',
        entityType: 'zone',
        entityId: id,
        data: { code: zone.code, before, after: data, changeNote: input.changeNote, version: after.version },
        ip: req.ip,
      });
      return after;
    });
    return this.present(s.cityId, result, result._count.wards);
  }
}
