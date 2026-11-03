import { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AuditService } from '../src/platform/audit.service';
import { CSRF, TestCtx, loginCitizen, loginStaff, readyDraft, registerOwner, setupCtx, submitNew, teardownCtx } from './helpers';

let ctx: TestCtx;
beforeAll(async () => {
  ctx = await setupCtx();
});
afterAll(async () => teardownCtx(ctx));

describe('admin application queue and detail', () => {
  it('lists submitted applications (never drafts), oldest first, with masked NIDs and SLA', async () => {
    const { agent } = await loginCitizen(ctx);
    const nid = await registerOwner(agent);
    const draftId = await readyDraft(ctx, agent);
    const sub = await submitNew(ctx, agent);
    const staff = await loginStaff(ctx, { roleCode: 'INTAKE_OFFICER' });
    const list = await staff.agent.get('/api/v1/admin/applications?limit=100').expect(200);
    const ids = list.body.items.map((x: { id: string }) => x.id);
    expect(ids).toContain(sub.id);
    expect(ids).not.toContain(draftId);
    const item = list.body.items.find((x: { id: string }) => x.id === sub.id);
    expect(item).toMatchObject({ applicationNumber: sub.applicationNumber, status: 'SUBMITTED', sla: 'ON_TRACK', workingDaysElapsed: 0 });
    expect(item.owner.nidMasked).toBe(`••••••${nid.slice(-4)}`);
    expect(JSON.stringify(list.body)).not.toContain(nid);
    expect(item.zone.code).toBe('Z1');

    const search = await staff.agent.get(`/api/v1/admin/applications?q=${sub.applicationNumber}`).expect(200);
    expect(search.body.items).toHaveLength(1);
    await staff.agent.get(`/api/v1/admin/applications/${draftId}`).expect(404);

    const summary = await staff.agent.get('/api/v1/admin/applications/summary').expect(200);
    expect(summary.body.byStatus.SUBMITTED).toBeGreaterThanOrEqual(1);
    expect(summary.body.byZone.map((z: { code: string }) => z.code)).toEqual(['Z1', 'Z2', 'Z3', 'Z4']);
  });

  it('paginates with a cursor without duplicates', async () => {
    const { agent } = await loginCitizen(ctx);
    await registerOwner(agent);
    for (let i = 0; i < 3; i++) await submitNew(ctx, agent);
    const staff = await loginStaff(ctx, { roleCode: 'INTAKE_OFFICER' });
    const seen = new Set<string>();
    let cursor: string | null = null;
    let pages = 0;
    do {
      const res: { body: { items: { id: string }[]; nextCursor: string | null } } = await staff.agent
        .get(`/api/v1/admin/applications?limit=2${cursor ? `&cursor=${cursor}` : ''}`)
        .expect(200);
      for (const it of res.body.items) {
        expect(seen.has(it.id)).toBe(false);
        seen.add(it.id);
      }
      cursor = res.body.nextCursor;
      pages++;
    } while (cursor && pages < 200);
    expect(seen.size).toBeGreaterThanOrEqual(3);
  });

  it('shows full detail with masked NIDs, quota usage and documents; audits every view and download', async () => {
    const { agent, phone } = await loginCitizen(ctx);
    const nid = await registerOwner(agent);
    const sub = await submitNew(ctx, agent);
    const staff = await loginStaff(ctx, { roleCode: 'VERIFICATION_OFFICER' });
    const d = await staff.agent.get(`/api/v1/admin/applications/${sub.id}`).expect(200);
    expect(d.body.applicationNumber).toBe(sub.applicationNumber);
    expect(d.body.applicantPhone).toBe(`+88${phone}`);
    expect(d.body.owner.nidMasked).toBe(`••••••${nid.slice(-4)}`);
    expect(d.body.owner.quota).toMatchObject({ used: 1, remaining: 4 });
    expect(d.body.vehicle).toMatchObject({ seatType: 'TWO_SEAT', status: 'PENDING_APPROVAL' });
    expect(d.body.driver.nidMasked).toMatch(/^••••••\d{4}$/);
    expect(d.body.documents).toHaveLength(10);
    expect(d.body.timeline.map((t: { toStatus: string }) => t.toStatus)).toEqual(['DRAFT', 'SUBMITTED']);
    expect(JSON.stringify(d.body)).not.toContain(nid);
    const doc = d.body.documents.find((x: { docType: string }) => x.docType === 'FITNESS_CERTIFICATE');
    const f = await staff.agent.get(`/api/v1/admin/applications/${sub.id}/documents/${doc.id}/file`).expect(200);
    expect(f.headers['content-type']).toBe('application/pdf');
    const audits = await ctx.owner.auditEvent.findMany({ where: { entityId: sub.id, action: { in: ['admin.application_viewed', 'admin.document_viewed'] } } });
    expect(audits.map((a) => a.action).sort()).toEqual(['admin.application_viewed', 'admin.document_viewed']);
  });

  it('restricts zone-scoped officers to their zone', async () => {
    const { agent } = await loginCitizen(ctx);
    await registerOwner(agent);
    const sub = await submitNew(ctx, agent); // Z1
    const z2 = await loginStaff(ctx, { roleCode: 'INTAKE_OFFICER', zoneCode: 'Z2' });
    await z2.agent.get(`/api/v1/admin/applications/${sub.id}`).expect(404);
    const list = await z2.agent.get('/api/v1/admin/applications?limit=100').expect(200);
    expect(list.body.items.every((x: { zone: { code: string } }) => x.zone.code === 'Z2')).toBe(true);
  });

  it('rejects malformed query parameters', async () => {
    const staff = await loginStaff(ctx, { roleCode: 'INTAKE_OFFICER' });
    await staff.agent.get('/api/v1/admin/applications?status=DRAFT').expect(400);
    await staff.agent.get('/api/v1/admin/applications?limit=1000').expect(400);
    await staff.agent.get('/api/v1/admin/applications/not-a-uuid').expect(404);
  });
});

describe('zone configuration (Z1–Z4)', () => {
  it('lists the four proposed zones with plate examples and flags poor white-on-yellow contrast', async () => {
    const admin = await loginStaff(ctx, { roleCode: 'DSCC_ADMIN' });
    const r = await admin.agent.get('/api/v1/admin/zones').expect(200);
    expect(r.body.map((z: { code: string }) => z.code)).toEqual(['Z1', 'Z2', 'Z3', 'Z4']);
    const z1 = r.body[0];
    expect(z1.examples).toEqual({ systemId: 'DSCC-Z1-000001', plateBn: 'ঢাকা দক্ষিণ-ক-০০০০০১' });
    expect(z1.plateContrastOk).toBe(true);
    const z3 = r.body[2];
    expect(z3.plateContrastOk).toBe(false);
    expect(r.body.every((z: { approvalStatus: string }) => z.approvalStatus !== undefined)).toBe(true);
  });

  it('updates a zone with optimistic locking, keeps a version history and audits the change', async () => {
    const admin = await loginStaff(ctx, { roleCode: 'DSCC_ADMIN' });
    const zones = (await admin.agent.get('/api/v1/admin/zones').expect(200)).body;
    const z3 = zones[2];
    const body = {
      nameBn: z3.nameBn,
      nameEn: z3.nameEn,
      uiColour: z3.uiColour,
      plateBackgroundColour: '#8D6E00',
      plateAreaCodeBn: z3.plateAreaCodeBn,
      vehicleQuota: 1200,
      approvalStatus: 'PROPOSED',
      changeNote: 'সাদা অক্ষরের জন্য গাঢ় হলুদ প্রস্তাব',
      version: z3.version,
    };
    const u = await admin.agent.patch(`/api/v1/admin/zones/${z3.id}`).set(CSRF).send(body).expect(200);
    expect(u.body).toMatchObject({ version: z3.version + 1, vehicleQuota: 1200, approvalStatus: 'PROPOSED', plateBackgroundColour: '#8D6E00' });
    const stale = await admin.agent.patch(`/api/v1/admin/zones/${z3.id}`).set(CSRF).send(body).expect(409);
    expect(stale.body.error.code).toBe('CONFLICT');
    const clash = await admin.agent
      .patch(`/api/v1/admin/zones/${z3.id}`)
      .set(CSRF)
      .send({ ...body, plateAreaCodeBn: 'ক', version: u.body.version })
      .expect(409);
    expect(clash.body.error.code).toBe('ZONE_PLATE_CODE_TAKEN');
    const badColour = await admin.agent
      .patch(`/api/v1/admin/zones/${z3.id}`)
      .set(CSRF)
      .send({ ...body, uiColour: 'yellow', version: u.body.version })
      .expect(400);
    expect(badColour.body.error.details.fields.uiColour).toBe('COLOUR_INVALID');
    const versions = await admin.agent.get(`/api/v1/admin/zones/${z3.id}/versions`).expect(200);
    expect(versions.body[0]).toMatchObject({ version: z3.version + 1, changeNote: body.changeNote });
    expect(versions.body[0].changedBy).toBe('পরীক্ষা কর্মকর্তা');
    const audit = await ctx.owner.auditEvent.findFirst({ where: { entityId: z3.id, action: 'zone.updated' }, orderBy: { id: 'desc' } });
    expect((audit!.data as { before: { plateBackgroundColour: string } }).before.plateBackgroundColour).toBe(z3.plateBackgroundColour);
  });
});

describe('platform integrity', () => {
  it('row-level security hides city data when no city (or another city) is set', async () => {
    const c = new Client({ connectionString: process.env.DATABASE_URL });
    await c.connect();
    try {
      const none = await c.query('SELECT count(*)::int AS n FROM applications');
      expect(none.rows[0].n).toBe(0);
      await c.query("SELECT set_config('app.city_id', '00000000-0000-7000-8000-000000000000', false)");
      const other = await c.query('SELECT count(*)::int AS n FROM zones');
      expect(other.rows[0].n).toBe(0);
      const city = await ctx.owner.city.findFirstOrThrow();
      await c.query("SELECT set_config('app.city_id', $1, false)", [city.id]);
      const mine = await c.query('SELECT count(*)::int AS n FROM zones');
      expect(mine.rows[0].n).toBe(4);
      await expect(
        c.query("INSERT INTO zones (id, city_id, code, name_bn, name_en, ui_colour, plate_background_colour, plate_area_code_bn) VALUES (gen_random_uuid(), '00000000-0000-7000-8000-000000000000', 'Z9', 'x', 'x', '#000000', '#000000', 'ঙ')"),
      ).rejects.toThrow(/row-level security/);
    } finally {
      await c.end();
    }
  });

  it('the runtime role cannot delete records or rewrite the audit log', async () => {
    const c = new Client({ connectionString: process.env.DATABASE_URL });
    await c.connect();
    try {
      await expect(c.query('DELETE FROM applications')).rejects.toThrow(/permission denied/);
      await expect(c.query("UPDATE audit_events SET action = 'x'")).rejects.toThrow(/permission denied/);
      await expect(c.query('DELETE FROM vehicle_quota_slots')).rejects.toThrow(/permission denied/);
    } finally {
      await c.end();
    }
    // Even the schema owner cannot alter audit rows (trigger).
    await expect(ctx.owner.$executeRawUnsafe("UPDATE audit_events SET action = 'tampered' WHERE id = (SELECT min(id) FROM audit_events)")).rejects.toThrow(/append-only/);
  });

  it('the audit hash chain verifies end to end', async () => {
    const audit = ctx.app.get(AuditService);
    expect(await audit.verifyChain()).toBeNull();
  });

  it('serves security headers and hides framework details', async () => {
    const { agent } = await loginCitizen(ctx);
    const r = await agent.get('/api/v1/me').expect(200);
    expect(r.headers['x-powered-by']).toBeUndefined();
    expect(r.headers['content-security-policy']).toContain("default-src 'none'");
    expect(r.headers['x-frame-options']).toBeDefined();
    const nf = await agent.get('/api/v1/does-not-exist').expect(404);
    expect(nf.body.error.code).toBe('NOT_FOUND');
  });
});
