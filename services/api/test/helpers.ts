import { INestApplication } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import { randomInt } from 'node:crypto';
import request from 'supertest';
import TestAgent from 'supertest/lib/agent';
import { createApp } from '../src/bootstrap';
import { loadConfig } from '../src/config';
import { createStaff } from '../src/seed/create-staff';
import { OutboxService } from '../src/platform/outbox.service';
import { totpAt } from '../src/platform/totp';

export type Agent = TestAgent;

export interface TestCtx {
  app: INestApplication;
  owner: PrismaClient; // schema owner (bypasses RLS) for assertions and fixtures
  outbox: OutboxService;
  catalog: { zoneId: string; wardId: string; otherZoneWardId: string; twoSeatModelId: string; fourSeatModelId: string };
}

export async function setupCtx(): Promise<TestCtx> {
  const app = await createApp(loadConfig());
  // Listen once so parallel supertest agents share one server instead of each binding their own port.
  await app.listen(0, '127.0.0.1');
  const owner = new PrismaClient({ datasources: { db: { url: process.env.MIGRATION_DATABASE_URL } } });
  const outbox = app.get(OutboxService);
  const zones = await owner.zone.findMany({ orderBy: { code: 'asc' } });
  const ward = await owner.ward.findFirstOrThrow({ where: { zoneId: zones[0].id } });
  const otherWard = await owner.ward.findFirstOrThrow({ where: { zoneId: zones[1].id } });
  const two = await owner.approvedModel.findFirstOrThrow({ where: { seatType: 'TWO_SEAT' } });
  const four = await owner.approvedModel.findFirstOrThrow({ where: { seatType: 'FOUR_SEAT' } });
  return {
    app,
    owner,
    outbox,
    catalog: { zoneId: zones[0].id, wardId: ward.id, otherZoneWardId: otherWard.id, twoSeatModelId: two.id, fourSeatModelId: four.id },
  };
}

export async function teardownCtx(ctx: TestCtx): Promise<void> {
  await ctx.owner.$disconnect();
  await ctx.app.close();
}

export const CSRF = { 'x-dscc-csrf': '1' };

let phoneCounter = randomInt(10_000_000, 80_000_000);
export function uniquePhone(): string {
  phoneCounter += 1;
  return `017${String(phoneCounter).padStart(8, '0')}`;
}

/** Random 10-digit NID that the simulator accepts (does not end in 0000). */
export function uniqueNid(): string {
  for (;;) {
    const n = String(randomInt(1_000_000_000, 9_999_999_999));
    if (!n.endsWith('0000')) return n;
  }
}

let chassisCounter = randomInt(100_000, 900_000);
export function uniqueSerial(prefix: string): string {
  chassisCounter += 1;
  return `${prefix}${chassisCounter}`;
}

export async function latestOtp(ctx: TestCtx, phoneE164: string): Promise<string> {
  // The outbox poller is single-flight; under parallel tests another caller may hold it, so retry.
  for (let i = 0; i < 100; i++) {
    await ctx.outbox.dispatchPending();
    const sms = await ctx.owner.simulatedSms.findFirst({ where: { toPhone: phoneE164 }, orderBy: { createdAt: 'desc' } });
    const m = sms && /OTP (\d{6})/.exec(sms.body);
    if (m) return m[1];
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error('no OTP SMS delivered');
}

export function e164(local: string): string {
  return `+88${local}`;
}

/** Full citizen login via OTP; returns a cookie-carrying agent. Accepts the privacy notice unless told not to. */
export async function loginCitizen(ctx: TestCtx, phone = uniquePhone(), opts: { consent?: boolean } = {}): Promise<{ agent: Agent; phone: string }> {
  const agent = request.agent(ctx.app.getHttpServer());
  const r1 = await agent.post('/api/v1/auth/otp/request').set(CSRF).send({ phone }).expect(200);
  const code = await latestOtp(ctx, e164(phone));
  await agent.post('/api/v1/auth/otp/verify').set(CSRF).send({ challengeId: r1.body.challengeId, code }).expect(200);
  if (opts.consent !== false) {
    await agent.post('/api/v1/me/consent').set(CSRF).send({ noticeVersion: '2026-11-v1' }).expect(200);
  }
  return { agent, phone };
}

export function ownerBody(nid: string, dob = '1985-02-10') {
  return {
    nid,
    dateOfBirth: dob,
    nameBn: 'রহিম উদ্দিন',
    nameEn: 'Rahim Uddin',
    fatherNameBn: 'করিম উদ্দিন',
    motherNameBn: 'রহিমা খাতুন',
    presentAddress: 'লালবাগ, ঢাকা',
    permanentAddress: 'লালবাগ, ঢাকা',
    education: 'SSC',
    declareCitizen: true,
    declareSoundMind: true,
  };
}

export async function registerOwner(agent: Agent, nid = uniqueNid(), dob?: string) {
  await agent.post('/api/v1/owners/me/identity').set(CSRF).send(ownerBody(nid, dob)).expect(201);
  return nid;
}

export function fullForm(ctx: TestCtx, over: { chassisNo?: string; motorNo?: string; wardId?: string } = {}) {
  return {
    vehicle: {
      seatType: 'TWO_SEAT',
      modelId: ctx.catalog.twoSeatModelId,
      manufactureYear: 2025,
      chassisNo: over.chassisNo ?? uniqueSerial('CH'),
      motorNo: over.motorNo ?? uniqueSerial('MT'),
      batteryType: 'LITHIUM_ION',
      hasSpeedometer: true,
    },
    location: { zoneId: ctx.catalog.zoneId, wardId: over.wardId ?? ctx.catalog.wardId, chargingLocation: 'লালবাগ চার্জিং স্টেশন' },
    driver: { nameBn: 'করিম চালক', nid: uniqueNid(), dateOfBirth: '1992-03-04', phone: uniquePhone(), address: 'লালবাগ, ঢাকা' },
    declaration: { truthful: true },
  };
}

// Minimal valid PNG (1×1) and PDF payloads.
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

export async function uploadAllDocs(agent: Agent, appId: string): Promise<void> {
  for (const t of REQUIRED_DOCS) {
    const isPdf = t === 'FITNESS_CERTIFICATE' || t === 'FEE_RECEIPT';
    await agent
      .post(`/api/v1/applications/${appId}/documents`)
      .set(CSRF)
      .field('docType', t)
      .attach('file', isPdf ? PDF : PNG, isPdf ? 'নথি.pdf' : 'photo.png')
      .expect(201);
  }
}

/** Create a draft, fill the complete form and upload all documents. Returns the draft id. */
export async function readyDraft(ctx: TestCtx, agent: Agent, over: Parameters<typeof fullForm>[1] = {}): Promise<string> {
  const d = await agent.post('/api/v1/applications').set(CSRF).expect(201);
  await agent.patch(`/api/v1/applications/${d.body.id}`).set(CSRF).send({ version: d.body.version, form: fullForm(ctx, over) }).expect(200);
  await uploadAllDocs(agent, d.body.id);
  return d.body.id;
}

export async function submitNew(ctx: TestCtx, agent: Agent): Promise<{ id: string; applicationNumber: string }> {
  const id = await readyDraft(ctx, agent);
  const r = await agent.post(`/api/v1/applications/${id}/submit`).set(CSRF).expect(200);
  return { id, applicationNumber: r.body.applicationNumber };
}

/** Staff login including TOTP enrolment on first use. Returns an authenticated agent and the TOTP secret. */
export async function loginStaff(
  ctx: TestCtx,
  p: { roleCode: string; email?: string; zoneCode?: string; password?: string },
): Promise<{ agent: Agent; email: string; secret: string }> {
  const email = p.email ?? `officer.${randomInt(1, 1e9)}@dscc.test`;
  const password = p.password ?? 'correct horse battery staple';
  await createStaff(ctx.owner, { email, fullName: 'পরীক্ষা কর্মকর্তা', roleCode: p.roleCode, cityCode: 'DSCC', password, zoneCode: p.zoneCode });
  const agent = request.agent(ctx.app.getHttpServer());
  const login = await agent.post('/api/v1/staff/auth/login').set(CSRF).send({ email, password }).expect(200);
  if (login.body.mfaEnrolled) throw new Error('expected first login');
  const en = await agent.get('/api/v1/staff/auth/mfa/enrollment').expect(200);
  await agent.post('/api/v1/staff/auth/mfa/verify').set(CSRF).send({ code: totpAt(en.body.secret, Date.now()) }).expect(200);
  return { agent, email, secret: en.body.secret };
}
