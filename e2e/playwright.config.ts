import { defineConfig, devices } from '@playwright/test';
import path from 'node:path';

/**
 * End-to-end tests against production builds of the API, citizen portal and admin dashboard, using a
 * dedicated database (dscc_e2e) that prepare.cjs recreates from migrations before the API starts. Build first: `pnpm build`.
 * The Next.js apps proxy /api to API_ORIGIN, which is fixed at build time (default http://127.0.0.1:4000).
 */
const root = path.join(__dirname, '..');
const k = (c: string) => Buffer.alloc(32, c).toString('base64');
export const E2E = {
  dbApp: process.env.E2E_DATABASE_URL ?? 'postgresql://dscc_app:dscc_app_dev@localhost:5432/dscc_e2e',
  dbOwner: process.env.E2E_MIGRATION_DATABASE_URL ?? 'postgresql://dscc_owner:dscc_owner_dev@localhost:5432/dscc_e2e',
  portal: 'http://127.0.0.1:3000',
  admin: 'http://127.0.0.1:3001',
  staffPassword: 'e2e-officer-password-2026',
};

export default defineConfig({
  testDir: './tests',
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 90_000,
  expect: { timeout: 10_000 },
  reporter: [['list']],
  use: { trace: 'retain-on-failure', locale: 'bn-BD', timezoneId: 'Asia/Dhaka' },
  projects: [
    { name: 'desktop', use: { ...devices['Desktop Chrome'] }, testIgnore: /mobile\.spec/ },
    { name: 'mobile', use: { ...devices['Pixel 7'] }, testMatch: /mobile\.spec/ },
  ],
  webServer: [
    {
      command: `node ${path.join(root, 'e2e/prepare.cjs')} && node ${path.join(root, 'services/api/dist/main.js')}`,
      url: 'http://127.0.0.1:4000/api/v1/health',
      reuseExistingServer: false,
      timeout: 60_000,
      env: {
        NODE_ENV: 'development',
        PORT: '4000',
        DATABASE_URL: E2E.dbApp,
        DATA_ENCRYPTION_KEY: k('D'),
        NID_HMAC_KEY: k('N'),
        OTP_HMAC_KEY: k('O'),
        SESSION_HMAC_KEY: k('S'),
        COOKIE_SECURE: 'false',
        STORAGE_DIR: path.join(root, 'e2e/.storage'),
        OUTBOX_POLL_MS: '200',
        OTP_IP_HOURLY_LIMIT: '1000',
      },
    },
    {
      command: 'pnpm --filter @dscc/portal start',
      url: `${'http://127.0.0.1:3000'}/login`,
      reuseExistingServer: false,
      timeout: 60_000,
      cwd: root,
    },
    {
      command: 'pnpm --filter @dscc/admin start',
      url: `${'http://127.0.0.1:3001'}/login`,
      reuseExistingServer: false,
      timeout: 60_000,
      cwd: root,
    },
  ],
});
