import { z } from 'zod';

const key32 = z
  .string()
  .min(1, 'required')
  .refine((s) => Buffer.from(s, 'base64').length === 32, 'must be 32 bytes, base64-encoded');

const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().default(4000),
  HOST: z.string().default('127.0.0.1'),
  DATABASE_URL: z.string().min(1),
  CITY_CODE: z.string().regex(/^[A-Z]{2,8}$/).default('DSCC'),
  DATA_ENCRYPTION_KEY: key32,
  NID_HMAC_KEY: key32,
  OTP_HMAC_KEY: key32,
  SESSION_HMAC_KEY: key32,
  SMS_PROVIDER: z.enum(['simulator']).default('simulator'),
  NID_VERIFICATION_PROVIDER: z.enum(['simulator', 'manual']).default('simulator'),
  // Phase 2. Only the payment simulator exists until DSCC approves a government gateway (Gate D).
  PAYMENT_PROVIDER: z.enum(['simulator']).default('simulator'),
  PAYMENT_WEBHOOK_SECRET: key32,
  // Ed25519 private key seed (32 bytes, base64) that signs QR credentials. Production: from the KMS/HSM.
  QR_SIGNING_KEY: key32,
  // Public origin of the verification page encoded in QR codes, e.g. https://verify.example.gov.bd
  PUBLIC_VERIFY_BASE_URL: z.string().url().default('http://localhost:3000'),
  FITNESS_VALIDITY_MONTHS: z.coerce.number().int().min(1).max(60).default(12),
  MAINTENANCE_POLL_MS: z.coerce.number().int().default(60_000),
  STORAGE_DIR: z.string().default('./storage'),
  COOKIE_SECURE: z
    .enum(['true', 'false'])
    .default('true')
    .transform((v) => v === 'true'),
  OTP_IP_HOURLY_LIMIT: z.coerce.number().int().min(1).default(20),
  OUTBOX_POLL_MS: z.coerce.number().int().default(1000),
  TRUST_PROXY: z
    .enum(['true', 'false'])
    .default('false')
    .transform((v) => v === 'true'),
});

export type AppConfig = z.infer<typeof schema>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const r = schema.safeParse(env);
  if (!r.success) {
    const msg = r.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
    throw new Error(`Invalid configuration: ${msg}`);
  }
  if (r.data.NODE_ENV === 'production' && (r.data.SMS_PROVIDER === 'simulator' || r.data.NID_VERIFICATION_PROVIDER === 'simulator' || r.data.PAYMENT_PROVIDER === 'simulator')) {
    throw new Error('Simulator adapters cannot run with NODE_ENV=production (Gate D not approved).');
  }
  return r.data;
}

export const CONFIG = Symbol('CONFIG');
