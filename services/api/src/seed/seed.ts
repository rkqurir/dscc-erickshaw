import { toBengaliDigits } from '@dscc/domain';
import { PrismaClient } from '@prisma/client';
import { CITY, PERMISSIONS, ROLES, SAMPLE_HOLIDAYS, SAMPLE_MODELS, ZONES, sampleWards } from './reference-data';

/** Idempotent reference-data seed. Must run as the schema owner (MIGRATION_DATABASE_URL). */
export async function seedReferenceData(prisma: PrismaClient): Promise<void> {
  const city = await prisma.city.upsert({ where: { code: CITY.code }, create: CITY, update: {} });

  for (const z of ZONES) {
    const existing = await prisma.zone.findUnique({ where: { cityId_code: { cityId: city.id, code: z.code } } });
    if (!existing) {
      const zone = await prisma.zone.create({ data: { cityId: city.id, ...z, approvalStatus: 'DRAFT' } });
      await prisma.zoneVersion.create({
        data: { zoneId: zone.id, cityId: city.id, version: 1, snapshot: { ...z, approvalStatus: 'DRAFT', vehicleQuota: null }, changeNote: 'প্রাথমিক প্রস্তাব (DSCC অনুমোদন সাপেক্ষ)' },
      });
    }
  }
  const zones = await prisma.zone.findMany({ where: { cityId: city.id } });
  const zoneByCode = new Map(zones.map((z) => [z.code, z.id]));
  for (const w of sampleWards()) {
    await prisma.ward.upsert({
      where: { cityId_number: { cityId: city.id, number: w.number } },
      create: {
        cityId: city.id,
        zoneId: zoneByCode.get(w.zoneCode)!,
        number: w.number,
        nameBn: `ওয়ার্ড নং ${toBengaliDigits(w.number)}`,
        nameEn: `Ward ${w.number}`,
        isSample: true,
      },
      update: {},
    });
  }

  for (const p of PERMISSIONS) {
    await prisma.permission.upsert({ where: { code: p.code }, create: p, update: { description: p.description } });
  }
  for (const r of ROLES) {
    await prisma.role.upsert({ where: { code: r.code }, create: { code: r.code, nameBn: r.nameBn, nameEn: r.nameEn }, update: { nameBn: r.nameBn, nameEn: r.nameEn } });
    for (const p of r.permissions) {
      await prisma.rolePermission.upsert({
        where: { roleCode_permissionCode: { roleCode: r.code, permissionCode: p } },
        create: { roleCode: r.code, permissionCode: p },
        update: {},
      });
    }
  }

  for (const m of SAMPLE_MODELS) {
    let man = await prisma.manufacturer.findFirst({ where: { nameEn: m.manufacturer.nameEn } });
    if (!man) man = await prisma.manufacturer.create({ data: { ...m.manufacturer, isSample: true } });
    for (const model of m.models) {
      const exists = await prisma.approvedModel.findFirst({ where: { manufacturerId: man.id, name: model.name } });
      if (!exists) await prisma.approvedModel.create({ data: { manufacturerId: man.id, name: model.name, seatType: model.seatType, isSample: true } });
    }
  }

  for (const h of SAMPLE_HOLIDAYS) {
    const date = new Date(`${h.date}T00:00:00Z`);
    await prisma.workingDayHoliday.upsert({ where: { date }, create: { date, nameBn: h.nameBn }, update: {} });
  }
}

if (require.main === module) {
  const url = process.env.MIGRATION_DATABASE_URL;
  if (!url) {
    console.error('MIGRATION_DATABASE_URL is required');
    process.exit(1);
  }
  const prisma = new PrismaClient({ datasources: { db: { url } } });
  seedReferenceData(prisma)
    .then(() => console.log('Reference data seeded.'))
    .catch((e) => {
      console.error(e);
      process.exitCode = 1;
    })
    .finally(() => prisma.$disconnect());
}
