import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { OtpService } from '../src/modules/auth/citizen-auth';
import { CSRF, TestCtx, e164, latestOtp, loginCitizen, loginStaff, setupCtx, teardownCtx, uniquePhone } from './helpers';
import { totpAt } from '../src/platform/totp';
import { createStaff } from '../src/seed/create-staff';

let ctx: TestCtx;
beforeAll(async () => {
  ctx = await setupCtx();
});
afterAll(async () => teardownCtx(ctx));

const api = () => request(ctx.app.getHttpServer());

describe('citizen OTP login', () => {
  it('rejects invalid Bangladeshi numbers with a Bengali message', async () => {
    const r = await api().post('/api/v1/auth/otp/request').set(CSRF).send({ phone: '01212345678' }).expect(400);
    expect(r.body.error.code).toBe('VALIDATION_FAILED');
    expect(r.body.error.details.fields.phone).toBe('PHONE_INVALID');
    expect(r.body.error.message).toMatch(/তথ্য সঠিক নয়/);
  });

  it('requires the CSRF header on state-changing requests', async () => {
    const r = await api().post('/api/v1/auth/otp/request').send({ phone: uniquePhone() }).expect(403);
    expect(r.body.error.code).toBe('CSRF_HEADER_MISSING');
  });

  it('logs in with a correct OTP (Bengali digits accepted), sets an HttpOnly cookie and stores only a hash', async () => {
    const local = uniquePhone();
    const bn = local.replace(/\d/g, (d) => '০১২৩৪৫৬৭৮৯'[Number(d)]);
    const r1 = await api().post('/api/v1/auth/otp/request').set(CSRF).send({ phone: bn }).expect(200);
    expect(r1.body).toMatchObject({ expiresInSeconds: 300, resendAfterSeconds: 60 });
    const code = await latestOtp(ctx, e164(local));
    const ch = await ctx.owner.otpChallenge.findUniqueOrThrow({ where: { id: r1.body.challengeId } });
    expect(ch.codeHash).not.toContain(code);
    expect(ch.codeHash).toHaveLength(64);
    const r2 = await api().post('/api/v1/auth/otp/verify').set(CSRF).send({ challengeId: r1.body.challengeId, code }).expect(200);
    expect(r2.body).toEqual({ phone: e164(local), needsConsent: true });
    const cookie = String(r2.headers['set-cookie']);
    expect(cookie).toMatch(/dscc_sid=/);
    expect(cookie).toMatch(/HttpOnly/);
    expect(cookie).toMatch(/SameSite=Strict/);
  });

  it('rejects a wrong code, a reused code and an expired code with the same error', async () => {
    const phone = uniquePhone();
    const r1 = await api().post('/api/v1/auth/otp/request').set(CSRF).send({ phone }).expect(200);
    const code = await latestOtp(ctx, e164(phone));
    const wrong = code === '000000' ? '111111' : '000000';
    const bad = await api().post('/api/v1/auth/otp/verify').set(CSRF).send({ challengeId: r1.body.challengeId, code: wrong }).expect(400);
    expect(bad.body.error.code).toBe('OTP_INVALID');
    await api().post('/api/v1/auth/otp/verify').set(CSRF).send({ challengeId: r1.body.challengeId, code }).expect(200);
    const reuse = await api().post('/api/v1/auth/otp/verify').set(CSRF).send({ challengeId: r1.body.challengeId, code }).expect(400);
    expect(reuse.body.error.code).toBe('OTP_INVALID');

    const phone2 = uniquePhone();
    const r3 = await api().post('/api/v1/auth/otp/request').set(CSRF).send({ phone: phone2 }).expect(200);
    const code2 = await latestOtp(ctx, e164(phone2));
    await ctx.owner.otpChallenge.update({ where: { id: r3.body.challengeId }, data: { expiresAt: new Date(Date.now() - 1000) } });
    const expired = await api().post('/api/v1/auth/otp/verify').set(CSRF).send({ challengeId: r3.body.challengeId, code: code2 }).expect(400);
    expect(expired.body.error.code).toBe('OTP_INVALID');
  });

  it('locks a challenge after 5 wrong attempts even if the 6th is correct', async () => {
    const phone = uniquePhone();
    const r1 = await api().post('/api/v1/auth/otp/request').set(CSRF).send({ phone }).expect(200);
    const code = await latestOtp(ctx, e164(phone));
    const wrong = code === '999999' ? '888888' : '999999';
    for (let i = 0; i < 5; i++) {
      await api().post('/api/v1/auth/otp/verify').set(CSRF).send({ challengeId: r1.body.challengeId, code: wrong }).expect(400);
    }
    await api().post('/api/v1/auth/otp/verify').set(CSRF).send({ challengeId: r1.body.challengeId, code }).expect(400);
  });

  it('enforces the resend cooldown, the hourly per-phone limit and the per-IP limit', async () => {
    const phone = uniquePhone();
    await api().post('/api/v1/auth/otp/request').set(CSRF).send({ phone }).expect(200);
    const cd = await api().post('/api/v1/auth/otp/request').set(CSRF).send({ phone }).expect(429);
    expect(cd.body.error.code).toBe('OTP_RESEND_COOLDOWN');

    const phone2 = uniquePhone();
    const old = new Date(Date.now() - 10 * 60_000);
    for (let i = 0; i < 5; i++) {
      await ctx.owner.otpChallenge.create({ data: { phoneE164: e164(phone2), codeHash: 'x', expiresAt: old, createdAt: old } });
    }
    const lim = await api().post('/api/v1/auth/otp/request').set(CSRF).send({ phone: phone2 }).expect(429);
    expect(lim.body.error.code).toBe('RATE_LIMITED');

    const otp = ctx.app.get(OtpService);
    const ip = '203.0.113.77';
    (otp as unknown as { config: { OTP_IP_HOURLY_LIMIT: number } }).config.OTP_IP_HOURLY_LIMIT = 3;
    try {
      for (let i = 0; i < 3; i++) await ctx.owner.otpChallenge.create({ data: { phoneE164: e164(uniquePhone()), codeHash: 'x', ip, expiresAt: old, createdAt: old } });
      await expect(otp.request(e164(uniquePhone()), ip)).rejects.toMatchObject({ code: 'RATE_LIMITED', status: 429 });
    } finally {
      (otp as unknown as { config: { OTP_IP_HOURLY_LIMIT: number } }).config.OTP_IP_HOURLY_LIMIT = 100000;
    }
  });

  it('requires privacy consent before owner features, then allows them', async () => {
    const { agent } = await loginCitizen(ctx, uniquePhone(), { consent: false });
    const me = await agent.get('/api/v1/me').expect(200);
    expect(me.body.hasConsent).toBe(false);
    const r = await agent.get('/api/v1/owners/me/vehicle-quota').expect(403);
    expect(r.body.error.code).toBe('CONSENT_REQUIRED');
    await agent.post('/api/v1/me/consent').set(CSRF).send({ noticeVersion: '2026-11-v1' }).expect(200);
    const r2 = await agent.get('/api/v1/owners/me/vehicle-quota').expect(403);
    expect(r2.body.error.code).toBe('OWNER_REGISTRATION_REQUIRED');
  });

  it('logout revokes the session', async () => {
    const { agent } = await loginCitizen(ctx);
    await agent.get('/api/v1/me').expect(200);
    await agent.post('/api/v1/auth/logout').set(CSRF).expect(204);
    await agent.get('/api/v1/me').expect(401);
  });
});

describe('staff login with TOTP MFA and RBAC', () => {
  it('enrols TOTP on first login, then requires it; rejects replayed codes', async () => {
    const { email, secret } = await loginStaff(ctx, { roleCode: 'INTAKE_OFFICER' });
    const a = request.agent(ctx.app.getHttpServer());
    const login = await a.post('/api/v1/staff/auth/login').set(CSRF).send({ email, password: 'correct horse battery staple' }).expect(200);
    expect(login.body.mfaEnrolled).toBe(true);
    // Password alone does not grant access.
    const pre = await a.get('/api/v1/admin/applications').expect(401);
    expect(pre.body.error.code).toBe('MFA_REQUIRED');
    await a.get('/api/v1/staff/auth/mfa/enrollment').expect(409);
    // The code already used at enrolment (same 30 s step) is a replay.
    const replay = await a.post('/api/v1/staff/auth/mfa/verify').set(CSRF).send({ code: totpAt(secret, Date.now()) }).expect(401);
    expect(replay.body.error.code).toBe('MFA_INVALID');
    await a.post('/api/v1/staff/auth/mfa/verify').set(CSRF).send({ code: totpAt(secret, Date.now() + 30_000) }).expect(200);
    const me = await a.get('/api/v1/staff/auth/me').expect(200);
    expect(me.body.roles).toEqual(['INTAKE_OFFICER']);
    expect(me.body.permissions).toEqual(['application.read', 'zone.read']);
  });

  it('stores the TOTP secret encrypted', async () => {
    const { email, secret } = await loginStaff(ctx, { roleCode: 'INTAKE_OFFICER' });
    const row = await ctx.owner.staffAccount.findUniqueOrThrow({ where: { email } });
    expect(row.totpSecretEnc).not.toContain(secret);
    expect(row.passwordHash).toMatch(/^scrypt\$/);
  });

  it('rejects wrong passwords and locks the account after five failures', async () => {
    const email = `lock.${Date.now()}@dscc.test`;
    await createStaff(ctx.owner, { email, fullName: 'Lock Test', roleCode: 'INTAKE_OFFICER', cityCode: 'DSCC', password: 'a-very-long-password' });
    for (let i = 0; i < 5; i++) {
      const r = await api().post('/api/v1/staff/auth/login').set(CSRF).send({ email, password: 'wrong-password!!' }).expect(401);
      expect(r.body.error.code).toBe('STAFF_LOGIN_FAILED');
    }
    const locked = await api().post('/api/v1/staff/auth/login').set(CSRF).send({ email, password: 'a-very-long-password' }).expect(423);
    expect(locked.body.error.code).toBe('STAFF_LOCKED');
    const unknown = await api().post('/api/v1/staff/auth/login').set(CSRF).send({ email: 'nobody@dscc.test', password: 'whatever-password' }).expect(401);
    expect(unknown.body.error.code).toBe('STAFF_LOGIN_FAILED');
  });

  it('keeps citizen and staff sessions apart', async () => {
    const { agent } = await loginCitizen(ctx);
    await agent.get('/api/v1/admin/applications').expect(401);
    await agent.get('/api/v1/admin/zones').expect(401);
    const staff = await loginStaff(ctx, { roleCode: 'DSCC_ADMIN' });
    await staff.agent.get('/api/v1/applications').expect(401);
  });

  it('denies actions outside the role (zone.manage) with 403', async () => {
    const intake = await loginStaff(ctx, { roleCode: 'INTAKE_OFFICER' });
    const zones = await intake.agent.get('/api/v1/admin/zones').expect(200);
    const z = zones.body[0];
    const r = await intake.agent
      .patch(`/api/v1/admin/zones/${z.id}`)
      .set(CSRF)
      .send({ ...z, vehicleQuota: 10, changeNote: 'x', version: z.version })
      .expect(403);
    expect(r.body.error.code).toBe('FORBIDDEN');
    const op = await loginStaff(ctx, { roleCode: 'UCAR_OPERATOR' });
    await op.agent.get('/api/v1/admin/applications').expect(403);
  });
});
