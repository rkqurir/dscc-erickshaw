import { Controller, Get, Query } from '@nestjs/common';
import { z } from 'zod';
import { CityService } from '../../platform/city.service';
import { parseOrThrow } from '../../platform/errors';
import { PrismaService } from '../../platform/prisma.service';

/** Public reference data used by the application form. */
@Controller('catalog')
export class CatalogController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly cities: CityService,
  ) {}

  @Get('zones')
  async zones() {
    const city = await this.cities.defaultCity();
    return this.prisma.inCity(city.id, async (tx) => {
      const zones = await tx.zone.findMany({ orderBy: { code: 'asc' } });
      return zones.map((z) => ({
        id: z.id,
        code: z.code,
        nameBn: z.nameBn,
        nameEn: z.nameEn,
        uiColour: z.uiColour,
        approvalStatus: z.approvalStatus,
      }));
    });
  }

  @Get('wards')
  async wards(@Query() q: unknown) {
    const { zoneId } = parseOrThrow(z.object({ zoneId: z.string().uuid().optional() }), q);
    const city = await this.cities.defaultCity();
    return this.prisma.inCity(city.id, async (tx) => {
      const wards = await tx.ward.findMany({ where: zoneId ? { zoneId } : {}, orderBy: { number: 'asc' } });
      return wards.map((w) => ({ id: w.id, zoneId: w.zoneId, number: w.number, nameBn: w.nameBn, nameEn: w.nameEn, isSample: w.isSample }));
    });
  }

  @Get('models')
  async models() {
    const ms = await this.prisma.manufacturer.findMany({
      include: { models: { where: { isActive: true }, orderBy: { name: 'asc' } } },
      orderBy: { nameEn: 'asc' },
    });
    return ms.map((m) => ({
      id: m.id,
      nameBn: m.nameBn,
      nameEn: m.nameEn,
      isSample: m.isSample,
      models: m.models.map((x) => ({ id: x.id, name: x.name, seatType: x.seatType, isSample: x.isSample })),
    }));
  }

  @Get('city')
  async city() {
    const c = await this.cities.defaultCity();
    return { code: c.code, nameBn: c.nameBn, nameEn: c.nameEn };
  }
}
