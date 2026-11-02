// Test configuration. Keys are fixed, test-only values; never reuse them elsewhere.
const k = (c: string) => Buffer.alloc(32, c).toString('base64');
process.env.NODE_ENV = 'test';
process.env.DATABASE_URL = process.env.TEST_DATABASE_URL ?? 'postgresql://dscc_app:dscc_app_dev@localhost:5432/dscc_test';
process.env.MIGRATION_DATABASE_URL = process.env.TEST_MIGRATION_DATABASE_URL ?? 'postgresql://dscc_owner:dscc_owner_dev@localhost:5432/dscc_test';
process.env.DATA_ENCRYPTION_KEY = k('d');
process.env.NID_HMAC_KEY = k('n');
process.env.OTP_HMAC_KEY = k('o');
process.env.SESSION_HMAC_KEY = k('s');
process.env.COOKIE_SECURE = 'false';
process.env.STORAGE_DIR = process.env.TEST_STORAGE_DIR ?? './storage-test';
process.env.CITY_CODE = 'DSCC';
process.env.OTP_IP_HOURLY_LIMIT = '100000';
