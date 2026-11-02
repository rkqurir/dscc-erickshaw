import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { PrismaClient } from '@prisma/client';
import { Client } from 'pg';
import { seedReferenceData } from '../src/seed/seed';

/** Recreate the test database schema from migrations, then seed reference data. */
export default async function setup(): Promise<void> {
  const ownerUrl = process.env.TEST_MIGRATION_DATABASE_URL ?? 'postgresql://dscc_owner:dscc_owner_dev@localhost:5432/dscc_test';
  const appRole = process.env.APP_DB_ROLE ?? 'dscc_app';
  const c = new Client({ connectionString: ownerUrl });
  await c.connect();
  await c.query('DROP SCHEMA IF EXISTS public CASCADE; CREATE SCHEMA public;');
  await c.end();
  const root = path.join(__dirname, '..');
  const env = { ...process.env, MIGRATION_DATABASE_URL: ownerUrl, APP_DB_ROLE: appRole };
  execFileSync(process.execPath, [path.join(root, 'scripts/migrate.js')], { cwd: root, env, stdio: 'pipe' });
  const prisma = new PrismaClient({ datasources: { db: { url: ownerUrl } } });
  await seedReferenceData(prisma);
  await prisma.$disconnect();
}
