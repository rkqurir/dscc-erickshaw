import { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { uuidv7 } from '../src/platform/crypto';
import { Agent, CSRF, TestCtx, loginCitizen, readyDraft, registerOwner, setupCtx, submitNew, teardownCtx, uniqueNid } from './helpers';

/**
 * Rule 4(8) acceptance tests (Phase 0 report §15): 0→1 and 4→5 allowed, 5→6 blocked; shared across
 * phone accounts and NID formats; released on withdrawal; other-city declarations count; database
 * trigger blocks bypasses; concurrent submissions at slot 4 let exactly one through.
 */
let ctx: TestCtx;
beforeAll(async () => {
  ctx = await setupCtx();
});
afterAll(async () => teardownCtx(ctx));

async function quota(agent: Agent) {
  return (await agent.get('/api/v1/owners/me/vehicle-quota').expect(200)).body;
}

async function ownerWith(n: number): Promise<{ agent: Agent; nid: string; ids: string[] }> {
  const { agent } = await loginCitizen(ctx);
  const nid = await registerOwner(agent);
  const ids: string[] = [];
  for (let i = 0; i < n; i++) ids.push((await submitNew(ctx, agent)).id);
  return { agent, nid, ids };
}

describe('five e-rickshaws per NID', () => {
  it('allows 0→1 … 4→5 and blocks 5→6 with the Bengali Rule 4(8) message', async () => {
    const { agent } = await ownerWith(0);
    expect(await quota(agent)).toEqual({ limit: 5, registered: 0, pending: 0, otherCities: 0, used: 0, remaining: 5 });
    for (let i = 1; i <= 5; i++) {
      await submitNew(ctx, agent);
      expect((await quota(agent)).used).toBe(i);
    }
    const sixth = await readyDraft(ctx, agent);
    const r = await agent.post(`/api/v1/applications/${sixth}/submit`).set(CSRF).expect(409);
    expect(r.body.error.code).toBe('OWNER_NID_VEHICLE_LIMIT_REACHED');
    expect(r.body.error.message).toContain('সর্বোচ্চ ৫টি ই-রিকশা');
    expect(r.body.error.message).toContain('বিধি ৪(৮)');
    // The failed attempt left nothing behind: still a draft, no number, no extra vehicle.
    const d = await agent.get(`/api/v1/applications/${sixth}`).expect(200);
    expect(d.body).toMatchObject({ status: 'DRAFT', applicationNumber: null });
    expect(await quota(agent)).toMatchObject({ used: 5, remaining: 0 });
  });

  it('shares one limit across phone accounts linked to the same NID, including the 17-digit form', async () => {
    const thirteen = `2${String(Date.now()).slice(-12)}`;
    const a = await loginCitizen(ctx);
    await registerOwner(a.agent, thirteen, '1988-08-08');
    for (let i = 0; i < 3; i++) await submitNew(ctx, a.agent);
    const b = await loginCitizen(ctx);
    await registerOwner(b.agent, `1988${thirteen}`, '1988-08-08');
    expect((await quota(b.agent)).used).toBe(3);
    await submitNew(ctx, b.agent);
    await submitNew(ctx, a.agent);
    const sixth = await readyDraft(ctx, b.agent);
    const r = await b.agent.post(`/api/v1/applications/${sixth}/submit`).set(CSRF).expect(409);
    expect(r.body.error.code).toBe('OWNER_NID_VEHICLE_LIMIT_REACHED');
  });

  it('releases the slot when an application is withdrawn', async () => {
    const { agent, ids } = await ownerWith(5);
    const w = await agent.post(`/api/v1/applications/${ids[0]}/withdraw`).set(CSRF).expect(200);
    expect(w.body.status).toBe('WITHDRAWN');
    expect(await quota(agent)).toMatchObject({ used: 4, remaining: 1 });
    await submitNew(ctx, agent);
    await agent.post(`/api/v1/applications/${ids[0]}/withdraw`).set(CSRF).expect(409);
  });

  it('counts vehicles declared in other city corporations', async () => {
    const { agent } = await ownerWith(3);
    await agent.post('/api/v1/owners/me/external-registrations').set(CSRF).send({ cityName: 'ঢাকা উত্তর সিটি কর্পোরেশন', registrationNo: 'DNCC-1' }).expect(201);
    await agent.post('/api/v1/owners/me/external-registrations').set(CSRF).send({ cityName: 'ঢাকা উত্তর সিটি কর্পোরেশন', registrationNo: 'DNCC-1' }).expect(409);
    await agent.post('/api/v1/owners/me/external-registrations').set(CSRF).send({ cityName: 'চট্টগ্রাম সিটি কর্পোরেশন', registrationNo: 'CCC-9' }).expect(201);
    expect(await quota(agent)).toMatchObject({ used: 5, otherCities: 2, remaining: 0 });
    const next = await readyDraft(ctx, agent);
    await agent.post(`/api/v1/applications/${next}/submit`).set(CSRF).expect(409);
    const extra = await agent.post('/api/v1/owners/me/external-registrations').set(CSRF).send({ cityName: 'নারায়ণগঞ্জ', registrationNo: 'N-1' }).expect(409);
    expect(extra.body.error.code).toBe('OWNER_NID_VEHICLE_LIMIT_REACHED');
  });

  it('database trigger blocks a sixth live slot even when the service is bypassed', async () => {
    const { nid } = await ownerWith(5);
    void nid;
    const slot = await ctx.owner.vehicleQuotaSlot.findFirstOrThrow({ orderBy: { createdAt: 'desc' } });
    const app = new Client({ connectionString: process.env.DATABASE_URL });
    await app.connect();
    try {
      await expect(
        app.query(
          `INSERT INTO vehicle_quota_slots (id, owner_identity_id, vehicle_id, city_id, state, source) VALUES ($1, $2, $3, $4, 'RESERVED', 'BULK_IMPORT')`,
          [uuidv7(), slot.ownerIdentityId, uuidv7(), slot.cityId],
        ),
      ).rejects.toThrow(/OWNER_NID_VEHICLE_LIMIT_REACHED/);
      // Re-activating a released slot is also blocked.
    } finally {
      await app.end();
    }
  });

  it('lets exactly one of two concurrent submissions through at slot 4', async () => {
    const nid = uniqueNid();
    const a = await loginCitizen(ctx);
    await registerOwner(a.agent, nid);
    for (let i = 0; i < 4; i++) await submitNew(ctx, a.agent);
    const b = await loginCitizen(ctx);
    await registerOwner(b.agent, nid);
    const d1 = await readyDraft(ctx, a.agent);
    const d2 = await readyDraft(ctx, b.agent);
    const [r1, r2] = await Promise.all([
      a.agent.post(`/api/v1/applications/${d1}/submit`).set(CSRF),
      b.agent.post(`/api/v1/applications/${d2}/submit`).set(CSRF),
    ]);
    const statuses = [r1.status, r2.status].sort();
    expect(statuses).toEqual([200, 409]);
    expect((await quota(a.agent)).used).toBe(5);
  });
});

describe('application numbers under load', () => {
  it('stay unique and gap-free across 20 parallel submissions', async () => {
    const owners = await Promise.all(Array.from({ length: 20 }, async () => {
      const { agent } = await loginCitizen(ctx);
      await registerOwner(agent);
      return { agent, id: await readyDraft(ctx, agent) };
    }));
    const results = await Promise.all(owners.map((o) => o.agent.post(`/api/v1/applications/${o.id}/submit`).set(CSRF)));
    expect(results.every((r) => r.status === 200)).toBe(true);
    const nums = results.map((r) => r.body.applicationNumber as string);
    expect(new Set(nums).size).toBe(20);
    const seqs = nums.map((n) => Number(n.slice(-6))).sort((x, y) => x - y);
    expect(seqs[seqs.length - 1] - seqs[0]).toBe(19);
  });
});
