import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  CSRF,
  PDF,
  PNG,
  TestCtx,
  e164,
  fullForm,
  loginCitizen,
  ownerBody,
  readyDraft,
  registerOwner,
  setupCtx,
  submitNew,
  teardownCtx,
  uniqueNid,
  uniqueSerial,
} from './helpers';

let ctx: TestCtx;
beforeAll(async () => {
  ctx = await setupCtx();
});
afterAll(async () => teardownCtx(ctx));

describe('owner registration with NID', () => {
  it('registers an owner, encrypts the NID and only exposes a masked value', async () => {
    const { agent } = await loginCitizen(ctx);
    const nid = uniqueNid();
    const r = await agent.post('/api/v1/owners/me/identity').set(CSRF).send(ownerBody(nid)).expect(201);
    expect(r.body).toMatchObject({ nameBn: 'রহিম উদ্দিন', nidMasked: `••••••${nid.slice(-4)}`, verificationStatus: 'SIMULATED_VERIFIED', linkedExisting: false });
    const row = await ctx.owner.ownerIdentity.findFirstOrThrow({ where: { nidLast4: nid.slice(-4) }, orderBy: { createdAt: 'desc' } });
    expect(row.nidEncrypted).not.toContain(nid);
    expect(row.nidHmac).not.toContain(nid);
    const audit = await ctx.owner.auditEvent.findFirstOrThrow({ where: { entityId: row.id, action: 'owner.registered' } });
    expect(JSON.stringify(audit.data)).not.toContain(nid);
    const again = await agent.post('/api/v1/owners/me/identity').set(CSRF).send(ownerBody(uniqueNid())).expect(409);
    expect(again.body.error.code).toBe('OWNER_ALREADY_REGISTERED');
  });

  it('rejects minors, missing declarations, malformed NIDs and simulator verification failures', async () => {
    const { agent } = await loginCitizen(ctx);
    const minor = await agent.post('/api/v1/owners/me/identity').set(CSRF).send(ownerBody(uniqueNid(), `${new Date().getUTCFullYear() - 15}-01-01`)).expect(400);
    expect(minor.body.error.details.fields.dateOfBirth).toBe('AGE_UNDER_18');
    const nodecl = await agent.post('/api/v1/owners/me/identity').set(CSRF).send({ ...ownerBody(uniqueNid()), declareCitizen: false }).expect(400);
    expect(nodecl.body.error.details.fields.declareCitizen).toBe('DECLARATION_REQUIRED');
    const bad = await agent.post('/api/v1/owners/me/identity').set(CSRF).send(ownerBody('12345')).expect(400);
    expect(bad.body.error.details.fields.nid).toBe('NID_INVALID_FORMAT');
    const yr = await agent.post('/api/v1/owners/me/identity').set(CSRF).send(ownerBody('19901234567890123', '1991-01-01')).expect(400);
    expect(yr.body.error.details.fields.nid).toBe('NID_BIRTH_YEAR_MISMATCH');
    const fail = await agent.post('/api/v1/owners/me/identity').set(CSRF).send(ownerBody('1234560000')).expect(422);
    expect(fail.body.error.code).toBe('NID_VERIFICATION_FAILED');
  });

  it('links a second phone to the same NID only with the matching date of birth', async () => {
    const nid = uniqueNid();
    const a = await loginCitizen(ctx);
    await registerOwner(a.agent, nid);
    const b = await loginCitizen(ctx);
    const mismatch = await b.agent.post('/api/v1/owners/me/identity').set(CSRF).send(ownerBody(nid, '1986-02-10')).expect(409);
    expect(mismatch.body.error.code).toBe('NID_DETAILS_MISMATCH');
    const ok = await b.agent.post('/api/v1/owners/me/identity').set(CSRF).send(ownerBody(nid)).expect(201);
    expect(ok.body.linkedExisting).toBe(true);
  });

  it('treats 13- and 17-digit forms of one NID as the same person', async () => {
    const thirteen = `1${String(Date.now()).slice(-12)}`;
    const a = await loginCitizen(ctx);
    await registerOwner(a.agent, thirteen, '1990-05-05');
    const b = await loginCitizen(ctx);
    const r = await b.agent.post('/api/v1/owners/me/identity').set(CSRF).send(ownerBody(`1990${thirteen}`, '1990-05-05')).expect(201);
    expect(r.body.linkedExisting).toBe(true);
  });
});

describe('application drafts, documents and submission', () => {
  it('requires owner registration before creating an application', async () => {
    const { agent } = await loginCitizen(ctx);
    const r = await agent.post('/api/v1/applications').set(CSRF).expect(403);
    expect(r.body.error.code).toBe('OWNER_REGISTRATION_REQUIRED');
  });

  it('saves drafts with optimistic versioning and reopens them', async () => {
    const { agent } = await loginCitizen(ctx);
    await registerOwner(agent);
    const d = await agent.post('/api/v1/applications').set(CSRF).expect(201);
    expect(d.body).toMatchObject({ status: 'DRAFT', version: 1 });
    const s1 = await agent.patch(`/api/v1/applications/${d.body.id}`).set(CSRF).send({ version: 1, form: { vehicle: { chassisNo: 'ABC123' } } }).expect(200);
    expect(s1.body.version).toBe(2);
    const stale = await agent.patch(`/api/v1/applications/${d.body.id}`).set(CSRF).send({ version: 1, form: {} }).expect(409);
    expect(stale.body.error.code).toBe('CONFLICT');
    const bad = await agent.patch(`/api/v1/applications/${d.body.id}`).set(CSRF).send({ version: 2, form: { evil: {} } }).expect(400);
    expect(bad.body.error.code).toBe('VALIDATION_FAILED');
    const got = await agent.get(`/api/v1/applications/${d.body.id}`).expect(200);
    expect(got.body.form).toEqual({ vehicle: { chassisNo: 'ABC123' } });
    expect(got.body.applicationNumber).toBeNull();
    await agent.delete(`/api/v1/applications/${d.body.id}`).set(CSRF).expect(204);
    await agent.get(`/api/v1/applications/${d.body.id}`).expect(404);
  });

  it('validates uploads by content, size and malware scan', async () => {
    const { agent } = await loginCitizen(ctx);
    await registerOwner(agent);
    const d = await agent.post('/api/v1/applications').set(CSRF).expect(201);
    const url = `/api/v1/applications/${d.body.id}/documents`;
    const txt = await agent.post(url).set(CSRF).field('docType', 'OWNER_PHOTO').attach('file', Buffer.from('hello'), 'photo.png').expect(415);
    expect(txt.body.error.code).toBe('FILE_TYPE_NOT_ALLOWED');
    const eicar = Buffer.concat([PNG, Buffer.from('X5O!P%@AP[4\\PZX54(P^)7CC)7}$EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*')]);
    const virus = await agent.post(url).set(CSRF).field('docType', 'OWNER_PHOTO').attach('file', eicar, 'photo.png').expect(422);
    expect(virus.body.error.code).toBe('FILE_REJECTED_BY_SCAN');
    const jsPdf = Buffer.concat([PDF, Buffer.from('/JavaScript (app.alert(1))')]);
    await agent.post(url).set(CSRF).field('docType', 'FEE_RECEIPT').attach('file', jsPdf, 'r.pdf').expect(422);
    const big = Buffer.concat([PNG, Buffer.alloc(5 * 1024 * 1024)]);
    const tooBig = await agent.post(url).set(CSRF).field('docType', 'OWNER_PHOTO').attach('file', big, 'big.png').expect(413);
    expect(tooBig.body.error.code).toBe('FILE_TOO_LARGE');
    const badType = await agent.post(url).set(CSRF).field('docType', 'PASSPORT').attach('file', PNG, 'p.png').expect(400);
    expect(badType.body.error.code).toBe('DOCUMENT_TYPE_INVALID');
    const ok = await agent.post(url).set(CSRF).field('docType', 'OWNER_PHOTO').attach('file', PNG, 'ছবি.png').expect(201);
    expect(ok.body).toMatchObject({ docType: 'OWNER_PHOTO', mimeType: 'image/png' });
    // Re-upload supersedes the previous file.
    await agent.post(url).set(CSRF).field('docType', 'OWNER_PHOTO').attach('file', PNG, 'new.png').expect(201);
    const got = await agent.get(`/api/v1/applications/${d.body.id}`).expect(200);
    expect(got.body.documents.filter((x: { docType: string }) => x.docType === 'OWNER_PHOTO')).toHaveLength(1);
    const file = await agent.get(`/api/v1/applications/${d.body.id}/documents/${got.body.documents[0].id}/file`).expect(200);
    expect(file.headers['content-type']).toBe('image/png');
    expect(file.headers['x-content-type-options']).toBe('nosniff');
  });

  it('refuses incomplete submissions and lists missing documents', async () => {
    const { agent } = await loginCitizen(ctx);
    await registerOwner(agent);
    const d = await agent.post('/api/v1/applications').set(CSRF).expect(201);
    const inc = await agent.post(`/api/v1/applications/${d.body.id}/submit`).set(CSRF).expect(400);
    expect(inc.body.error.code).toBe('APPLICATION_INCOMPLETE');
    expect(Object.keys(inc.body.error.details.fields)).toEqual(expect.arrayContaining(['vehicle', 'location', 'driver', 'declaration']));
    await agent.patch(`/api/v1/applications/${d.body.id}`).set(CSRF).send({ version: 1, form: fullForm(ctx) }).expect(200);
    const docs = await agent.post(`/api/v1/applications/${d.body.id}/submit`).set(CSRF).expect(400);
    expect(docs.body.error.code).toBe('DOCUMENTS_MISSING');
    // The fitness certificate is issued in the system before submission, so an uploaded copy is optional.
    expect(docs.body.error.details.missing).not.toContain('FITNESS_CERTIFICATE');
    expect(docs.body.error.details.missing).toContain('FEE_RECEIPT');
  });

  it('rejects a ward from another zone and a model that does not match the seat type', async () => {
    const { agent } = await loginCitizen(ctx);
    await registerOwner(agent);
    const id = await readyDraft(ctx, agent, { wardId: ctx.catalog.otherZoneWardId }, { certify: false });
    const r = await agent.post(`/api/v1/applications/${id}/submit`).set(CSRF).expect(400);
    expect(r.body.error.code).toBe('ZONE_WARD_MISMATCH');
    const form = fullForm(ctx);
    form.vehicle.modelId = ctx.catalog.fourSeatModelId;
    const cur = await agent.get(`/api/v1/applications/${id}`).expect(200);
    await agent.patch(`/api/v1/applications/${id}`).set(CSRF).send({ version: cur.body.version, form }).expect(200);
    const m = await agent.post(`/api/v1/applications/${id}/submit`).set(CSRF).expect(400);
    expect(m.body.error.code).toBe('MODEL_SEAT_MISMATCH');
  });

  it('submits, allocates DSCC-YYYY-NNNNNN, records a revision, timeline, SMS and audit, and is idempotent', async () => {
    const { agent, phone } = await loginCitizen(ctx);
    await registerOwner(agent);
    const id = await readyDraft(ctx, agent);
    const key = `submit-${Date.now()}`;
    const r = await agent.post(`/api/v1/applications/${id}/submit`).set(CSRF).set('Idempotency-Key', key).expect(200);
    expect(r.body.applicationNumber).toMatch(/^DSCC-20\d{2}-\d{6}$/);
    expect(r.body.status).toBe('SUBMITTED');
    expect(r.body.decisionDueDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    const replay = await agent.post(`/api/v1/applications/${id}/submit`).set(CSRF).set('Idempotency-Key', key).expect(200);
    expect(replay.body).toEqual(r.body);
    const again = await agent.post(`/api/v1/applications/${id}/submit`).set(CSRF).expect(409);
    expect(again.body.error.code).toBe('APPLICATION_INVALID_STATE');

    const got = await agent.get(`/api/v1/applications/${id}`).expect(200);
    expect(got.body.timeline.map((t: { toStatus: string }) => t.toStatus)).toEqual(['DRAFT', 'SUBMITTED']);
    const rev = await ctx.owner.applicationRevision.findFirstOrThrow({ where: { applicationId: id } });
    expect((rev.snapshot as { applicationNumber: string }).applicationNumber).toBe(r.body.applicationNumber);
    expect(JSON.stringify(rev.snapshot)).toMatch(/••••••\d{4}/);
    await ctx.outbox.dispatchPending();
    const sms = await ctx.owner.simulatedSms.findFirstOrThrow({ where: { toPhone: e164(phone) }, orderBy: { createdAt: 'desc' } });
    expect(sms.body).toContain(r.body.applicationNumber);
    const audit = await ctx.owner.auditEvent.findFirst({ where: { entityId: id, action: 'application.submitted' } });
    expect(audit).not.toBeNull();
    // Drafts can no longer be edited after submission.
    await agent.patch(`/api/v1/applications/${id}`).set(CSRF).send({ version: got.body.version, form: {} }).expect(409);
    await agent.post(`/api/v1/applications/${id}/documents`).set(CSRF).field('docType', 'OWNER_PHOTO').attach('file', PNG, 'x.png').expect(409);
  });

  it('blocks a chassis or motor number that is already live', async () => {
    const a = await loginCitizen(ctx);
    await registerOwner(a.agent);
    const chassisNo = uniqueSerial('DUP');
    const id1 = await readyDraft(ctx, a.agent, { chassisNo });
    await a.agent.post(`/api/v1/applications/${id1}/submit`).set(CSRF).expect(200);
    const b = await loginCitizen(ctx);
    await registerOwner(b.agent);
    const id2 = await readyDraft(ctx, b.agent, { chassisNo });
    const r = await b.agent.post(`/api/v1/applications/${id2}/submit`).set(CSRF).expect(409);
    expect(r.body.error.code).toBe('CHASSIS_ALREADY_REGISTERED');
    // After withdrawal the chassis number is free again.
    await a.agent.post(`/api/v1/applications/${id1}/withdraw`).set(CSRF).expect(200);
    await b.agent.post(`/api/v1/applications/${id2}/submit`).set(CSRF).expect(200);
  });

  it('never exposes one applicant’s application or documents to another (IDOR)', async () => {
    const a = await loginCitizen(ctx);
    await registerOwner(a.agent);
    const { id } = await submitNew(ctx, a.agent);
    const got = await a.agent.get(`/api/v1/applications/${id}`).expect(200);
    const docId = got.body.documents[0].id;
    const b = await loginCitizen(ctx);
    await registerOwner(b.agent);
    await b.agent.get(`/api/v1/applications/${id}`).expect(404);
    await b.agent.get(`/api/v1/applications/${id}/documents/${docId}/file`).expect(404);
    await b.agent.post(`/api/v1/applications/${id}/withdraw`).set(CSRF).expect(404);
    await b.agent.patch(`/api/v1/applications/${id}`).set(CSRF).send({ version: 1, form: {} }).expect(404);
    const list = await b.agent.get('/api/v1/applications').expect(200);
    expect(list.body.find((x: { id: string }) => x.id === id)).toBeUndefined();
  });
});
