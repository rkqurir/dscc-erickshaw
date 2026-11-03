import { APIRequestContext, Page, expect } from '@playwright/test';
import { E2E } from '../playwright.config';
import { createHmac, randomInt } from 'node:crypto';
import { Client } from 'pg';

export const PORTAL = 'http://127.0.0.1:3000';
export const ADMIN = 'http://127.0.0.1:3001';
export const CSRF = { 'x-dscc-csrf': '1' };

export function uniquePhone(): string {
  return `018${String(randomInt(10_000_000, 99_999_999))}`;
}
export function uniqueNid(): string {
  for (;;) {
    const n = String(randomInt(1_000_000_000, 9_999_999_999));
    if (!n.endsWith('0000')) return n;
  }
}

/** Read the OTP from the development SMS simulator (only exposed when SMS_PROVIDER=simulator, non-production). */
export async function readOtp(request: APIRequestContext, phone: string): Promise<string> {
  for (let i = 0; i < 50; i++) {
    const r = await request.get(`${PORTAL}/api/v1/dev/sms?phone=${phone}`);
    const rows = (await r.json()) as { body: string }[];
    const m = rows[0] && /OTP (\d{6})/.exec(rows[0].body);
    if (m) return m[1];
    await new Promise((res) => setTimeout(res, 200));
  }
  throw new Error('OTP not delivered');
}

export async function citizenLogin(page: Page, phone = uniquePhone()): Promise<string> {
  await page.goto(`${PORTAL}/login`);
  await page.getByLabel('মোবাইল নম্বর').fill(phone);
  await page.getByRole('button', { name: 'OTP পাঠান' }).click();
  await expect(page.getByText('নম্বরে OTP পাঠানো হয়েছে')).toBeVisible();
  const otp = await readOtp(page.request, phone);
  await page.getByLabel('৬ অঙ্কের OTP').fill(otp);
  await page.getByRole('button', { name: 'যাচাই করুন' }).click();
  return phone;
}

export async function acceptConsent(page: Page): Promise<void> {
  await expect(page.getByRole('heading', { name: 'গোপনীয়তা নোটিশ ও সম্মতি' })).toBeVisible();
  await page.getByLabel('আমি নোটিশটি পড়েছি এবং সম্মতি দিচ্ছি।').check();
  await page.getByRole('button', { name: 'সম্মতি দিয়ে এগিয়ে যান' }).click();
  await expect(page.getByRole('heading', { name: 'আমার ড্যাশবোর্ড' })).toBeVisible();
}

/** Register the owner through the API using the page's cookies (fast path for setup). */
export async function registerOwnerViaApi(page: Page, nid = uniqueNid()): Promise<string> {
  const r = await page.request.post(`${PORTAL}/api/v1/owners/me/identity`, {
    headers: CSRF,
    data: {
      nid,
      dateOfBirth: '1984-04-14',
      nameBn: 'জাহিদ হাসান',
      fatherNameBn: 'আব্দুল হাসান',
      motherNameBn: 'সালমা বেগম',
      presentAddress: 'হাজারীবাগ, ঢাকা',
      permanentAddress: 'হাজারীবাগ, ঢাকা',
      education: 'HSC',
      declareCitizen: true,
      declareSoundMind: true,
    },
  });
  expect(r.status()).toBe(201);
  return nid;
}

export const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);
export const PDF = Buffer.from('%PDF-1.4\n1 0 obj << /Type /Catalog >> endobj\ntrailer << /Root 1 0 R >>\n%%EOF\n');
export const REQUIRED_DOCS = [
  'OWNER_NID_COPY',
  'OWNER_PHOTO',
  'VEHICLE_PHOTO_FRONT',
  'VEHICLE_PHOTO_BACK',
  'VEHICLE_PHOTO_LEFT',
  'VEHICLE_PHOTO_RIGHT',
  'FITNESS_CERTIFICATE',
  'FEE_RECEIPT',
  'DRIVER_PHOTO',
  'DRIVER_NID_COPY',
];

/** Create and submit a complete application through the API with the page's session. */
export async function submitApplicationViaApi(page: Page): Promise<string> {
  return (await createSubmittedApplication(page)).applicationNumber;
}

/** A complete draft (form and documents) ready to submit once it has a fitness certificate. */
export async function createReadyDraft(page: Page): Promise<{ id: string; chassisNo: string }> {
  const req = page.request;
  const [zones, models] = await Promise.all([
    req.get(`${PORTAL}/api/v1/catalog/zones`).then((r) => r.json()),
    req.get(`${PORTAL}/api/v1/catalog/models`).then((r) => r.json()),
  ]);
  const wards = await req.get(`${PORTAL}/api/v1/catalog/wards?zoneId=${zones[1].id}`).then((r) => r.json());
  const model = models[0].models.find((m: { seatType: string }) => m.seatType === 'FOUR_SEAT');
  const d = await (await req.post(`${PORTAL}/api/v1/applications`, { headers: CSRF })).json();
  const chassisNo = `CHE${randomInt(1e6, 9e6)}`;
  const form = {
    vehicle: {
      seatType: 'FOUR_SEAT',
      modelId: model.id,
      manufactureYear: 2024,
      chassisNo,
      motorNo: `MTE${randomInt(1e6, 9e6)}`,
      batteryType: 'LIFEPO4',
      hasSpeedometer: true,
    },
    location: { zoneId: zones[1].id, wardId: wards[0].id, chargingLocation: 'ধানমন্ডি গ্যারেজ' },
    driver: { nameBn: 'রফিক মিয়া', nid: uniqueNid(), dateOfBirth: '1991-01-01', phone: uniquePhone(), address: 'ঢাকা' },
    declaration: { truthful: true },
  };
  expect((await req.patch(`${PORTAL}/api/v1/applications/${d.id}`, { headers: CSRF, data: { version: d.version, form } })).status()).toBe(200);
  for (const t of REQUIRED_DOCS) {
    const pdf = t === 'FITNESS_CERTIFICATE' || t === 'FEE_RECEIPT';
    const r = await req.post(`${PORTAL}/api/v1/applications/${d.id}/documents`, {
      headers: CSRF,
      multipart: { docType: t, file: { name: pdf ? 'doc.pdf' : 'photo.png', mimeType: pdf ? 'application/pdf' : 'image/png', buffer: pdf ? PDF : PNG } },
    });
    expect(r.status()).toBe(201);
  }
  return { id: d.id, chassisNo };
}

/**
 * Fixture: a passed, countersigned fitness certificate for the vehicle in the draft, written straight to the
 * test database. The inspection flow itself is exercised through the UI in workflow.spec.ts.
 */
export async function certifyViaDb(applicationId: string): Promise<void> {
  const c = new Client({ connectionString: E2E.dbOwner });
  await c.connect();
  try {
    const r = await c.query(
      `INSERT INTO fitness_inspections (id, city_id, application_id, chassis_no, motor_no, seat_type, model_id, status, scheduled_for, location,
         scheduled_by_staff_id, checklist, inspector_staff_id, inspected_at, countersigned_by_staff_id, countersigned_at, certificate_no, valid_until)
       SELECT gen_random_uuid(), a.city_id, a.id, a.form_data->'vehicle'->>'chassisNo', a.form_data->'vehicle'->>'motorNo', a.form_data->'vehicle'->>'seatType',
         (a.form_data->'vehicle'->>'modelId')::uuid, 'PASSED', now(), 'নগর ভবন', gen_random_uuid(),
         '{"BRAKES":"PASS","LIGHTING":"PASS","HORN":"PASS","SPEED_GOVERNOR":"PASS","CHASSIS_BODY":"PASS","SPEEDOMETER":"PASS"}'::jsonb,
         gen_random_uuid(), now(), gen_random_uuid(), now(), 'FIT-E2E-' || $2, current_date + 300
       FROM applications a WHERE a.id = $1::uuid`,
      [applicationId, `${Date.now()}${randomInt(1000, 9999)}`],
    );
    expect(r.rowCount).toBe(1);
  } finally {
    await c.end();
  }
}

export async function createSubmittedApplication(page: Page): Promise<{ id: string; applicationNumber: string }> {
  const d = await createReadyDraft(page);
  await certifyViaDb(d.id);
  const s = await page.request.post(`${PORTAL}/api/v1/applications/${d.id}/submit`, { headers: CSRF });
  expect(s.status()).toBe(200);
  return { id: d.id, applicationNumber: (await s.json()).applicationNumber };
}

/** RFC 6238 TOTP for the officer login flow. */
export function totp(secretB32: string, at = Date.now()): string {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let bits = 0;
  let value = 0;
  const bytes: number[] = [];
  for (const ch of secretB32.replace(/=+$/, '')) {
    value = (value << 5) | alphabet.indexOf(ch);
    bits += 5;
    if (bits >= 8) {
      bytes.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  const msg = Buffer.alloc(8);
  msg.writeBigUInt64BE(BigInt(Math.floor(at / 30000)));
  const h = createHmac('sha1', Buffer.from(bytes)).update(msg).digest();
  const off = h[h.length - 1] & 15;
  const bin = ((h[off] & 0x7f) << 24) | (h[off + 1] << 16) | (h[off + 2] << 8) | h[off + 3];
  return String(bin % 1e6).padStart(6, '0');
}

const staffSecrets = new Map<string, string>();
const lastStep = new Map<string, number>();

/**
 * A TOTP code for a time step the officer has not used yet. The API accepts each step once (login and
 * step-up share the counter) and allows ±1 step of clock drift, so wait for the clock if needed.
 */
export async function freshTotp(email: string): Promise<string> {
  const secret = staffSecrets.get(email);
  if (!secret) throw new Error(`no TOTP secret for ${email}`);
  for (;;) {
    const now = Math.floor(Date.now() / 30_000);
    const step = Math.max(now, (lastStep.get(email) ?? -1) + 1);
    if (step <= now + 1) {
      lastStep.set(email, step);
      return totp(secret, step * 30_000);
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
}

/** Officer login with password and TOTP (enrolling on first login). */
export async function staffLogin(page: Page, email: string): Promise<void> {
  await page.goto(`${ADMIN}/login`);
  await page.getByLabel('দাফতরিক ইমেইল').fill(email);
  await page.getByLabel('পাসওয়ার্ড').fill(E2E.staffPassword);
  await page.getByRole('button', { name: 'লগইন' }).click();
  const enroll = page.getByRole('heading', { name: 'দ্বি-স্তর যাচাই চালু করুন' });
  const mfa = page.getByRole('heading', { name: 'দ্বি-স্তর যাচাই', exact: true });
  await expect(enroll.or(mfa)).toBeVisible();
  if (await enroll.isVisible()) {
    await expect(page.getByRole('img', { name: 'TOTP QR' })).toBeVisible();
    const text = await page.getByTestId('totp-secret').innerText();
    staffSecrets.set(email, /([A-Z2-7]{32})/.exec(text)![1]);
  }
  await page.getByLabel('যাচাই কোড').fill(await freshTotp(email));
  await page.getByRole('button', { name: 'যাচাই করুন' }).click();
  await expect(page.getByRole('button', { name: 'লগআউট' })).toBeVisible();
}
