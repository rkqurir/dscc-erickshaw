#!/usr/bin/env node
/**
 * Applies Prisma migrations as the schema owner (MIGRATION_DATABASE_URL), then grants the
 * least-privilege runtime role (APP_DB_ROLE) only what it needs: no DELETE anywhere, and no UPDATE
 * on append-only tables. The runtime role is not the table owner, so Row-Level Security applies.
 */
const { execFileSync } = require('node:child_process');
const path = require('node:path');
const { Client } = require('pg');

const url = process.env.MIGRATION_DATABASE_URL;
const appRole = process.env.APP_DB_ROLE || 'dscc_app';
if (!url) {
  console.error('MIGRATION_DATABASE_URL is required');
  process.exit(1);
}
if (!/^[a-z_][a-z0-9_]*$/.test(appRole)) {
  console.error('APP_DB_ROLE must be a simple identifier');
  process.exit(1);
}

execFileSync(require.resolve('prisma/build/index.js'), ['migrate', 'deploy'], {
  cwd: path.join(__dirname, '..'),
  stdio: 'inherit',
  env: { ...process.env, DATABASE_URL: url },
});

(async () => {
  const c = new Client({ connectionString: url });
  await c.connect();
  await c.query(`
    GRANT USAGE ON SCHEMA public TO ${appRole};
    GRANT SELECT, INSERT, UPDATE ON ALL TABLES IN SCHEMA public TO ${appRole};
    REVOKE ALL ON TABLE _prisma_migrations FROM ${appRole};
    REVOKE UPDATE ON audit_events, application_revisions, application_status_events, zone_versions,
      verification_checks, application_decisions, payments, qr_scan_events FROM ${appRole};
    REVOKE INSERT, UPDATE ON roles, permissions, role_permissions, cities, manufacturers, approved_models, working_day_holidays, fee_schedules FROM ${appRole};
    GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO ${appRole};
  `);
  await c.end();
  console.log(`Grants applied to ${appRole}`);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
