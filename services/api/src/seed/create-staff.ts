import { PrismaClient } from '@prisma/client';
import { hashPassword } from '../platform/crypto';

/**
 * Create a staff account (no self-registration for staff).
 *   STAFF_PASSWORD=... node dist/seed/create-staff.js <email> "<full name>" <ROLE_CODE> [CITY_CODE]
 * The officer enrols TOTP on first login. Runs as the schema owner (MIGRATION_DATABASE_URL).
 */
export async function createStaff(
  prisma: PrismaClient,
  p: { email: string; fullName: string; roleCode: string; cityCode: string; password: string; zoneCode?: string },
): Promise<string> {
  if (p.password.length < 12) throw new Error('Password must be at least 12 characters');
  const city = await prisma.city.findUniqueOrThrow({ where: { code: p.cityCode } });
  await prisma.role.findUniqueOrThrow({ where: { code: p.roleCode } });
  const zone = p.zoneCode ? await prisma.zone.findUniqueOrThrow({ where: { cityId_code: { cityId: city.id, code: p.zoneCode } } }) : null;
  const email = p.email.trim().toLowerCase();
  const staff = await prisma.staffAccount.upsert({
    where: { email },
    create: { email, fullName: p.fullName, cityId: city.id, passwordHash: await hashPassword(p.password) },
    update: {},
  });
  await prisma.roleAssignment.upsert({
    where: { staffId_roleCode_cityId: { staffId: staff.id, roleCode: p.roleCode, cityId: city.id } },
    create: { staffId: staff.id, roleCode: p.roleCode, cityId: city.id, zoneId: zone?.id ?? null },
    update: {},
  });
  return staff.id;
}

if (require.main === module) {
  const [email, fullName, roleCode, cityCode = 'DSCC'] = process.argv.slice(2);
  const password = process.env.STAFF_PASSWORD ?? '';
  const url = process.env.MIGRATION_DATABASE_URL;
  if (!email || !fullName || !roleCode || !url) {
    console.error('Usage: STAFF_PASSWORD=... MIGRATION_DATABASE_URL=... node dist/seed/create-staff.js <email> "<full name>" <ROLE_CODE> [CITY_CODE]');
    process.exit(1);
  }
  const prisma = new PrismaClient({ datasources: { db: { url } } });
  createStaff(prisma, { email, fullName, roleCode, cityCode, password })
    .then((id) => console.log(`Staff account ready: ${id}`))
    .catch((e) => {
      console.error(e instanceof Error ? e.message : e);
      process.exitCode = 1;
    })
    .finally(() => prisma.$disconnect());
}
