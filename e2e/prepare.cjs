/**
 * Recreate the E2E database (dscc_e2e) from migrations, seed reference data and create one officer per
 * tested role. Runs before the API web server starts (Playwright starts web servers before global setup).
 */
const { execFileSync } = require('node:child_process');
const { rmSync } = require('node:fs');
const path = require('node:path');
const { Client } = require('pg');

const root = path.join(__dirname, '..');
const api = path.join(root, 'services/api');
const owner = process.env.E2E_MIGRATION_DATABASE_URL || 'postgresql://dscc_owner:dscc_owner_dev@localhost:5432/dscc_e2e';
const password = process.env.E2E_STAFF_PASSWORD || 'e2e-officer-password-2026';

(async () => {
  const admin = new Client({ connectionString: owner.replace(/\/[^/]+$/, '/postgres') });
  await admin.connect();
  const exists = await admin.query("SELECT 1 FROM pg_database WHERE datname = 'dscc_e2e'");
  if (!exists.rowCount) await admin.query('CREATE DATABASE dscc_e2e');
  await admin.end();
  const db = new Client({ connectionString: owner });
  await db.connect();
  await db.query('DROP SCHEMA IF EXISTS public CASCADE; CREATE SCHEMA public;');
  await db.end();
  rmSync(path.join(__dirname, '.storage'), { recursive: true, force: true });

  const env = { ...process.env, MIGRATION_DATABASE_URL: owner, APP_DB_ROLE: 'dscc_app', STAFF_PASSWORD: password };
  const run = (args) => execFileSync(process.execPath, args, { cwd: api, env, stdio: 'pipe' });
  run([path.join(api, 'scripts/migrate.js')]);
  run([path.join(api, 'dist/seed/seed.js')]);
  run([path.join(api, 'dist/seed/create-staff.js'), 'admin@dscc.test', 'আনিসুর রহমান', 'DSCC_ADMIN']);
  run([path.join(api, 'dist/seed/create-staff.js'), 'intake@dscc.test', 'নাসরিন আক্তার', 'INTAKE_OFFICER']);
  // Phase 2 workflow: each step is a different person (separation of duties).
  const officers = [
    ['verifier@dscc.test', 'শাহানা পারভীন', 'VERIFICATION_OFFICER'],
    ['approver@dscc.test', 'মাহবুব আলম', 'APPROVING_OFFICER'],
    ['approver2@dscc.test', 'ফারহানা ইসলাম', 'APPROVING_OFFICER'],
    ['inspector@dscc.test', 'কামরুল হাসান', 'INSPECTION_OFFICER'],
    ['traffic@dscc.test', 'সাইফুল ইসলাম', 'TRAFFIC_COUNTERSIGNER'],
    ['plate@dscc.test', 'রুবিনা ইয়াসমিন', 'PLATE_OFFICER'],
    ['appeal@dscc.test', 'মোস্তফা কামাল', 'APPEAL_AUTHORITY'],
  ];
  for (const [email, name, role] of officers) run([path.join(api, 'dist/seed/create-staff.js'), email, name, role]);
  console.log('E2E database ready');
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
