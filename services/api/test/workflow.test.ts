import { Client } from 'pg';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AuditService } from '../src/platform/audit.service';
import { DecisionService } from '../src/modules/workflow/decision.service';
import { FeesService } from '../src/modules/workflow/fees.service';
import { CSRF, TestCtx, certifyFitness, e164, fullForm, loginCitizen, readyDraft, registerOwner, setupCtx, submitNew, teardownCtx, uniqueSerial, PNG } from './helpers';
import { ALL_PASS, approvableApplication, fitnessViaApi, officer, payViaSimulator, stepUp, tomorrow } from './workflow-helpers';

let ctx: TestCtx;
beforeAll(async () => {
  ctx = await setupCtx();
});
afterAll(async () => teardownCtx(ctx));

async function smsTo(phone: string): Promise<string[]> {
  for (let i = 0; i < 20; i++) await ctx.outbox.dispatchPending();
  const rows = await ctx.owner.simulatedSms.findMany({ where: { toPhone: e164(phone) }, orderBy: { createdAt: 'asc' } });
  return rows.map((r) => r.body);
}

describe('approval workflow', () => {
  it('approves only when every gate is met, then issues a plate and a signed QR that verifies publicly without personal data', async () => {
    const { citizen, phone, nid, id, applicationNumber, fitness } = await approvableApplication(ctx, { fitness: 'api' });
    const approver = await officer(ctx, 'APPROVING_OFFICER');
    const wf = await approver.agent.get(`/api/v1/admin/applications/${id}/workflow`).expect(200);
    expect(wf.body.unmet).toEqual([]);
    expect(wf.body.can).toMatchObject({ decide: true, approve: true, startVerification: false });
    expect(wf.body.invoice).toMatchObject({ status: 'PAID', totalBdt: 8000 }); // registration (2-seat); fitness was paid before submission
    expect(wf.body.detail.fitnessCertificate.certificateNo).toBe(fitness!.certificateNo);
    expect(fitness!.certificateNo).toMatch(/^FIT-DSCC-\d{4}-\d{6}$/);

    const ok = await approver.agent.post(`/api/v1/admin/applications/${id}/approve`).set(CSRF).send({ totp: stepUp(approver) }).expect(200);
    expect(ok.body.status).toBe('APPROVED');
    const app = await ctx.owner.application.findUniqueOrThrow({ where: { id } });
    const slot = await ctx.owner.vehicleQuotaSlot.findFirstOrThrow({ where: { vehicleId: app.vehicleId! } });
    expect(slot.state).toBe('HELD');
    expect((await ctx.owner.vehicle.findUniqueOrThrow({ where: { id: app.vehicleId! } })).status).toBe('APPROVED');

    // The approving officer cannot also issue the plate.
    const approverAsPlate = await officer(ctx, 'PLATE_OFFICER');
    await ctx.owner.roleAssignment.create({ data: { staffId: (await ctx.owner.staffAccount.findFirstOrThrow({ where: { roleAssignments: { some: { roleCode: 'APPROVING_OFFICER' } } }, orderBy: { createdAt: 'desc' } })).id, roleCode: 'PLATE_OFFICER', cityId: app.cityId } });
    const sod = await approver.agent.post(`/api/v1/admin/applications/${id}/registration`).set(CSRF).send({ totp: stepUp(approver) }).expect(403);
    expect(sod.body.error.code).toBe('SEPARATION_OF_DUTIES');

    const issued = await approverAsPlate.agent.post(`/api/v1/admin/applications/${id}/registration`).set(CSRF).send({ totp: stepUp(approverAsPlate) }).expect(201);
    expect(issued.body.plateSystemId).toMatch(/^DSCC-Z1-\d{6}$/);
    expect(issued.body.plateTextBn).toMatch(/^ঢাকা দক্ষিণ-ক-[০-৯]{6}$/);
    expect(issued.body.qr.qrDataUrl).toMatch(/^data:image\/png;base64,/);
    expect(issued.body.qr.url).toMatch(/^https:\/\/verify\.dscc\.test\/v\/Q1\.DSCC\./);
    const again = await approverAsPlate.agent.post(`/api/v1/admin/applications/${id}/registration`).set(CSRF).send({ totp: '000000' }).expect(409);
    expect(again.body.error.code).toBe('REGISTRATION_ALREADY_ISSUED');

    const token = issued.body.qr.url.split('/v/')[1];
    const pub = await request(ctx.app.getHttpServer()).get(`/api/v1/public/verify/${token}`).expect(200);
    expect(pub.body).toMatchObject({ result: 'VALID', plate: { systemId: issued.body.plateSystemId }, zone: { code: 'Z1' }, fitness: { valid: true } });
    const body = JSON.stringify(pub.body);
    expect(body).not.toContain(nid);
    expect(body).not.toContain(phone);
    expect(body).not.toContain('রহিম'); // owner name
    expect(body).not.toContain('করিম'); // driver name

    // Tampering with the signature or token is detected.
    const tampered = token.slice(0, -2) + (token.endsWith('AA') ? 'BB' : 'AA');
    expect((await request(ctx.app.getHttpServer()).get(`/api/v1/public/verify/${tampered}`).expect(200)).body.result).toBe('INVALID');
    expect((await request(ctx.app.getHttpServer()).get('/api/v1/public/verify/not-a-token').expect(200)).body.result).toBe('INVALID');

    // Owner sees the plate and QR.
    const mine = await citizen.get(`/api/v1/applications/${id}`).expect(200);
    expect(mine.body.registration).toMatchObject({ plateSystemId: issued.body.plateSystemId, status: 'ACTIVE' });
    expect(mine.body.registration.validUntil > mine.body.registration.registeredOn).toBe(true);
    expect((await ctx.owner.vehicle.findUniqueOrThrow({ where: { id: app.vehicleId! } })).status).toBe('ACTIVE');

    // Lost plate: revoke and reissue; the old QR now reports REVOKED.
    const plate2 = await officer(ctx, 'PLATE_OFFICER');
    const re = await plate2.agent.post(`/api/v1/admin/registrations/${issued.body.id}/reissue-qr`).set(CSRF).send({ reason: 'LOST', totp: stepUp(plate2) }).expect(200);
    expect(re.body.qr.version).toBe(2);
    expect((await request(ctx.app.getHttpServer()).get(`/api/v1/public/verify/${token}`).expect(200)).body.result).toBe('REVOKED');
    const token2 = re.body.qr.url.split('/v/')[1];
    expect((await request(ctx.app.getHttpServer()).get(`/api/v1/public/verify/${token2}`).expect(200)).body.result).toBe('VALID');

    const key = await request(ctx.app.getHttpServer()).get('/api/v1/public/qr-key').expect(200);
    expect(key.body.alg).toBe('Ed25519');

    const sms = await smsTo(phone);
    expect(sms.some((m) => /চেসিস \S+-এর ফিটনেস সনদ/.test(m) && m.includes('এখন আবেদন জমা দিতে পারবেন'))).toBe(true);
    expect(sms.some((m) => /চেসিস \S+-এর ফি 1000 টাকা গৃহীত/.test(m))).toBe(true);
    expect(sms.some((m) => m.includes(`${applicationNumber}-এর ফি 8000 টাকা গৃহীত`))).toBe(true);
    expect(sms.some((m) => m.includes(`${applicationNumber} অনুমোদিত`))).toBe(true);
    expect(sms.some((m) => m.includes(issued.body.plateTextBn))).toBe(true);
    expect(await ctx.app.get(AuditService).verifyChain()).toBeNull();
  });

  it('refuses approval with unmet gates, without a fresh TOTP, by the verifying officer or without the permission', async () => {
    const verifier = await officer(ctx, 'VERIFICATION_OFFICER');
    const a = await approvableApplication(ctx, { verifier, skip: ['inspection', 'payment'] });
    const approver = await officer(ctx, 'APPROVING_OFFICER');
    const gates = await approver.agent.post(`/api/v1/admin/applications/${a.id}/approve`).set(CSRF).send({ totp: stepUp(approver) }).expect(409);
    expect(gates.body.error.code).toBe('APPROVAL_GATES_NOT_MET');
    expect(gates.body.error.details.unmet).toEqual(['FITNESS_CERTIFICATE_VALID', 'FEES_PAID']);
    await approver.agent.post(`/api/v1/admin/applications/${a.id}/approve`).set(CSRF).send({}).expect(400);
    const bad = await approver.agent.post(`/api/v1/admin/applications/${a.id}/approve`).set(CSRF).send({ totp: '123456' }).expect(403);
    expect(bad.body.error.code).toBe('STEP_UP_INVALID');

    // An officer holding both roles may not decide a file they verified (app check + database trigger).
    const vStaff = await ctx.owner.staffAccount.findFirstOrThrow({ where: { roleAssignments: { some: { roleCode: 'VERIFICATION_OFFICER' } } }, orderBy: { createdAt: 'desc' } });
    await ctx.owner.roleAssignment.create({ data: { staffId: vStaff.id, roleCode: 'APPROVING_OFFICER', cityId: vStaff.cityId } });
    const sod = await verifier.agent.post(`/api/v1/admin/applications/${a.id}/approve`).set(CSRF).send({ totp: stepUp(verifier) }).expect(403);
    expect(sod.body.error.code).toBe('SEPARATION_OF_DUTIES');
    await expect(
      ctx.owner.$executeRawUnsafe(
        `INSERT INTO application_decisions (id, city_id, application_id, decision, reason_codes, decided_by_staff_id, gates) VALUES (gen_random_uuid(), '${vStaff.cityId}', '${a.id}', 'APPROVED', '{}', '${vStaff.id}', '{}')`,
      ),
    ).rejects.toThrow(/SEPARATION_OF_DUTIES/);
    // Status cannot be flipped to APPROVED without a decision row, even by the schema owner.
    await expect(ctx.owner.$executeRawUnsafe(`UPDATE applications SET status = 'APPROVED' WHERE id = '${a.id}'`)).rejects.toThrow(/APPROVAL_DECISION_MISSING/);

    const intake = await officer(ctx, 'INTAKE_OFFICER');
    await intake.agent.post(`/api/v1/admin/applications/${a.id}/approve`).set(CSRF).send({ totp: stepUp(intake) }).expect(403);
    await a.citizen.post(`/api/v1/admin/applications/${a.id}/approve`).set(CSRF).send({ totp: '123456' }).expect(401);
    const inspector = await officer(ctx, 'INSPECTION_OFFICER');
    await inspector.agent.get(`/api/v1/admin/applications/${a.id}`).expect(403);
  });

  it('enforces the zone vehicle quota (Rule 3) at approval', async () => {
    const a = await approvableApplication(ctx);
    const zone = await ctx.owner.zone.findUniqueOrThrow({ where: { id: ctx.catalog.zoneId } });
    const used = await ctx.owner.vehicle.count({ where: { zoneId: zone.id, status: { in: ['APPROVED', 'ACTIVE', 'SUSPENDED'] } } });
    await ctx.owner.zone.update({ where: { id: zone.id }, data: { vehicleQuota: used } });
    try {
      const approver = await officer(ctx, 'APPROVING_OFFICER');
      const r = await approver.agent.post(`/api/v1/admin/applications/${a.id}/approve`).set(CSRF).send({ totp: stepUp(approver) }).expect(409);
      expect(r.body.error.details.unmet).toEqual(['ZONE_QUOTA_AVAILABLE']);
    } finally {
      await ctx.owner.zone.update({ where: { id: zone.id }, data: { vehicleQuota: null } });
    }
  });

  it('allocates distinct plate serials when officers issue at the same time', async () => {
    const apps = await Promise.all([0, 1, 2, 3].map(() => approvableApplication(ctx)));
    for (const a of apps) {
      const approver = await officer(ctx, 'APPROVING_OFFICER');
      await approver.agent.post(`/api/v1/admin/applications/${a.id}/approve`).set(CSRF).send({ totp: stepUp(approver) }).expect(200);
    }
    const plates = await Promise.all(apps.map(() => officer(ctx, 'PLATE_OFFICER')));
    const issued = await Promise.all(apps.map((a, i) => plates[i].agent.post(`/api/v1/admin/applications/${a.id}/registration`).set(CSRF).send({ totp: stepUp(plates[i]) })));
    expect(issued.map((r) => r.status)).toEqual([201, 201, 201, 201]);
    const ids = issued.map((r) => r.body.plateSystemId);
    expect(new Set(ids).size).toBe(4);
    const queue = await plates[0].agent.get('/api/v1/admin/registrations/queue').expect(200);
    expect(queue.body.filter((q: { registration: unknown }) => q.registration).length).toBeGreaterThanOrEqual(4);
  });
});

describe('correction requests', () => {
  it('sends the file back, lets the applicant correct and resubmit under the same number, and restarts verification', async () => {
    const { agent: citizen, phone } = await loginCitizen(ctx);
    await registerOwner(citizen);
    const sub = await submitNew(ctx, citizen);
    const v = await officer(ctx, 'INTAKE_OFFICER');
    await citizen.patch(`/api/v1/applications/${sub.id}`).set(CSRF).send({ version: 1, form: {} }).expect(409); // not editable while submitted
    await v.agent.post(`/api/v1/admin/applications/${sub.id}/request-correction`).set(CSRF).send({ items: ['vehicle'], message: 'চেসিস নম্বর ঠিক করুন' }).expect(409); // must start verification first
    await v.agent.post(`/api/v1/admin/applications/${sub.id}/start-verification`).set(CSRF).expect(200);
    await v.agent.post(`/api/v1/admin/applications/${sub.id}/request-correction`).set(CSRF).send({ items: ['bogus'], message: 'চেসিস নম্বর ঠিক করুন' }).expect(400);
    await v.agent
      .post(`/api/v1/admin/applications/${sub.id}/request-correction`)
      .set(CSRF)
      .send({ items: ['vehicle', 'VEHICLE_PHOTO_FRONT'], message: 'গাড়ির রং ছবির সাথে মিলছে না, ঠিক করুন' })
      .expect(200);
    await v.agent.post(`/api/v1/admin/applications/${sub.id}/checks`).set(CSRF).send({ item: 'ZONE_WARD', result: 'PASS' }).expect(409);

    const view = await citizen.get(`/api/v1/applications/${sub.id}`).expect(200);
    expect(view.body.status).toBe('CORRECTION_REQUESTED');
    expect(view.body.correction).toMatchObject({ open: true, items: ['vehicle', 'VEHICLE_PHOTO_FRONT'] });
    // The certified chassis cannot be swapped during a correction; other vehicle details can.
    const swapped = { ...view.body.form, vehicle: { ...view.body.form.vehicle, chassisNo: uniqueSerial('CHC') } };
    await citizen.patch(`/api/v1/applications/${sub.id}`).set(CSRF).send({ version: view.body.version, form: swapped }).expect(409);
    const form = { ...view.body.form, vehicle: { ...view.body.form.vehicle, colour: 'সবুজ' } };
    await citizen.patch(`/api/v1/applications/${sub.id}`).set(CSRF).send({ version: view.body.version, form }).expect(200);
    await citizen.post(`/api/v1/applications/${sub.id}/documents`).set(CSRF).field('docType', 'VEHICLE_PHOTO_FRONT').attach('file', PNG, 'front.png').expect(201);
    const re = await citizen.post(`/api/v1/applications/${sub.id}/submit`).set(CSRF).expect(200);
    expect(re.body).toMatchObject({ applicationNumber: sub.applicationNumber, status: 'SUBMITTED' });
    // DSCC decision, 2026-11-02: the 30-working-day deadline is not paused while the file is with the applicant.
    expect(re.body.decisionDueDate).toBe(view.body.decisionDueDate);

    const app = await ctx.owner.application.findUniqueOrThrow({ where: { id: sub.id } });
    expect((await ctx.owner.vehicle.findUniqueOrThrow({ where: { id: app.vehicleId! } })).colour).toBe('সবুজ');
    expect(await ctx.owner.applicationRevision.count({ where: { applicationId: sub.id } })).toBe(2);
    expect(await ctx.owner.correctionRequest.count({ where: { applicationId: sub.id, resolvedAt: null } })).toBe(0);
    expect(await ctx.owner.vehicleQuotaSlot.count({ where: { vehicleId: app.vehicleId!, state: { not: 'RELEASED' } } })).toBe(1);
    await v.agent.post(`/api/v1/admin/applications/${sub.id}/start-verification`).set(CSRF).expect(200);
    expect((await smsTo(phone)).some((m) => m.includes('সংশোধন প্রয়োজন'))).toBe(true);
  });
});

describe('fitness inspection before the application (DSCC decision, 2026-11-02)', () => {
  it('is requested and paid from the draft, scheduled, failed, re-requested, passed and countersigned before submission', async () => {
    const { agent: citizen, phone } = await loginCitizen(ctx);
    await registerOwner(citizen);
    const id = await readyDraft(ctx, citizen, {}, { certify: false });

    // No certificate, no submission: the applicant has to wait.
    const early = await citizen.post(`/api/v1/applications/${id}/submit`).set(CSRF).expect(400);
    expect(early.body.error.code).toBe('FITNESS_CERTIFICATE_REQUIRED');
    expect((await citizen.get(`/api/v1/applications/${id}`).expect(200)).body.fitness).toEqual({ certificate: null, openInspectionId: null, canRequest: true });

    // A draft without the vehicle details cannot request an inspection.
    const empty = await citizen.post('/api/v1/applications').set(CSRF).expect(201);
    const inc = await citizen.post(`/api/v1/applications/${empty.body.id}/fitness-request`).set(CSRF).expect(400);
    expect(inc.body.error.code).toBe('FITNESS_VEHICLE_INCOMPLETE');
    expect(Object.keys(inc.body.error.details.fields)).toEqual(expect.arrayContaining(['vehicle.chassisNo', 'vehicle.motorNo']));

    const r1 = await citizen.post(`/api/v1/applications/${id}/fitness-request`).set(CSRF).expect(201);
    expect(r1.body).toMatchObject({ status: 'REQUESTED', scheduledFor: null, invoice: { status: 'UNPAID', totalBdt: 1000 } });
    await citizen.post(`/api/v1/applications/${id}/fitness-request`).set(CSRF).expect(409);

    // The inspected rickshaw's chassis, motor, model and seat type are locked; other fields are not.
    const cur = await citizen.get(`/api/v1/applications/${id}`).expect(200);
    const locked = await citizen
      .patch(`/api/v1/applications/${id}`)
      .set(CSRF)
      .send({ version: cur.body.version, form: { ...cur.body.form, vehicle: { ...cur.body.form.vehicle, chassisNo: uniqueSerial('CHX') } } })
      .expect(409);
    expect(locked.body.error.code).toBe('VEHICLE_LOCKED_FOR_FITNESS');
    expect(locked.body.error.details.fields).toEqual({ 'vehicle.chassisNo': 'LOCKED' });
    await citizen
      .patch(`/api/v1/applications/${id}`)
      .set(CSRF)
      .send({ version: cur.body.version, form: { ...cur.body.form, driver: { ...cur.body.form.driver, nameBn: 'রফিক চালক' } } })
      .expect(200);

    // An appointment only after the fee is paid.
    const scheduler = await officer(ctx, 'VERIFICATION_OFFICER');
    const unpaid = await scheduler.agent.post(`/api/v1/admin/inspections/${r1.body.id}/schedule`).set(CSRF).send({ scheduledFor: tomorrow(), location: 'নগর ভবন' }).expect(409);
    expect(unpaid.body.error.code).toBe('FITNESS_FEE_UNPAID');
    const queue = await scheduler.agent.get('/api/v1/admin/inspections?status=REQUESTED').expect(200);
    expect(queue.body.find((x: { id: string }) => x.id === r1.body.id)).toMatchObject({ application: { applicationNumber: null, status: 'DRAFT' }, vehicle: { chassisNo: r1.body.chassisNo }, invoice: { status: 'UNPAID' } });
    await payViaSimulator(citizen, id, 'SUCCESS', r1.body.invoice.id);
    await scheduler.agent.post(`/api/v1/admin/inspections/${r1.body.id}/schedule`).set(CSRF).send({ scheduledFor: '2020-01-01T10:00:00Z', location: 'নগর ভবন' }).expect(400);
    await scheduler.agent.post(`/api/v1/admin/inspections/${r1.body.id}/schedule`).set(CSRF).send({ scheduledFor: tomorrow(), location: 'নগর ভবন' }).expect(200);
    // A cancelled appointment goes back to the queue; the paid fee is kept.
    const back = await scheduler.agent.post(`/api/v1/admin/inspections/${r1.body.id}/cancel`).set(CSRF).expect(200);
    expect(back.body).toMatchObject({ status: 'REQUESTED', scheduledFor: null });
    const when = new Date(Date.now() + 2 * 86_400_000).toISOString();
    const sch = await scheduler.agent.post(`/api/v1/admin/inspections/${r1.body.id}/schedule`).set(CSRF).send({ scheduledFor: when, location: 'নগর ভবন' }).expect(200);
    expect(sch.body).toMatchObject({ status: 'SCHEDULED', location: 'নগর ভবন', invoice: { status: 'PAID' } });

    const inspector = await officer(ctx, 'INSPECTION_OFFICER');
    await inspector.agent.post(`/api/v1/admin/inspections/${r1.body.id}/result`).set(CSRF).send({ checklist: { ...ALL_PASS, HORN: 'MAYBE' } }).expect(400);
    const failed = await inspector.agent.post(`/api/v1/admin/inspections/${r1.body.id}/result`).set(CSRF).send({ checklist: { ...ALL_PASS, BRAKES: 'FAIL' }, note: 'ব্রেক দুর্বল' }).expect(200);
    expect(failed.body.status).toBe('FAILED');
    const traffic = await officer(ctx, 'TRAFFIC_COUNTERSIGNER');
    await traffic.agent.post(`/api/v1/admin/inspections/${r1.body.id}/countersign`).set(CSRF).expect(409);

    // After repairs: a new request with its own fee.
    const r2 = await citizen.post(`/api/v1/applications/${id}/fitness-request`).set(CSRF).expect(201);
    expect(r2.body.invoice.id).not.toBe(r1.body.invoice.id);
    await payViaSimulator(citizen, id, 'SUCCESS', r2.body.invoice.id);
    await scheduler.agent.post(`/api/v1/admin/inspections/${r2.body.id}/schedule`).set(CSRF).send({ scheduledFor: when, location: 'নগর ভবন' }).expect(200);
    await inspector.agent.post(`/api/v1/admin/inspections/${r2.body.id}/result`).set(CSRF).send({ checklist: ALL_PASS }).expect(200);
    // The inspector holding the traffic role still cannot countersign their own inspection.
    const iStaff = await ctx.owner.staffAccount.findFirstOrThrow({ where: { roleAssignments: { some: { roleCode: 'INSPECTION_OFFICER' } } }, orderBy: { createdAt: 'desc' } });
    await ctx.owner.roleAssignment.create({ data: { staffId: iStaff.id, roleCode: 'TRAFFIC_COUNTERSIGNER', cityId: iStaff.cityId } });
    const own = await inspector.agent.post(`/api/v1/admin/inspections/${r2.body.id}/countersign`).set(CSRF).expect(403);
    expect(own.body.error.code).toBe('SEPARATION_OF_DUTIES');
    await expect(ctx.owner.$executeRawUnsafe(`UPDATE fitness_inspections SET countersigned_by_staff_id = inspector_staff_id WHERE id = '${r2.body.id}'`)).rejects.toThrow(/two_people/);

    const cert = await traffic.agent.post(`/api/v1/admin/inspections/${r2.body.id}/countersign`).set(CSRF).expect(200);
    expect(cert.body.certificateNo).toMatch(/^FIT-DSCC-\d{4}-\d{6}$/);
    expect(cert.body.validUntil > new Date().toISOString().slice(0, 10)).toBe(true);
    const done = await citizen.post(`/api/v1/applications/${id}/fitness-request`).set(CSRF).expect(409);
    expect(done.body.error.code).toBe('FITNESS_ALREADY_CERTIFIED');
    const view = await citizen.get(`/api/v1/applications/${id}`).expect(200);
    expect(view.body.fitness).toMatchObject({ certificate: { certificateNo: cert.body.certificateNo }, openInspectionId: null, canRequest: false });
    expect(view.body.inspections.map((x: { status: string }) => x.status)).toEqual(['FAILED', 'PASSED']);
    expect(view.body.fitnessInvoices.map((x: { status: string }) => x.status)).toEqual(['PAID', 'PAID']);
    expect(view.body.invoice).toBeNull(); // the registration fee comes with submission
    await citizen
      .patch(`/api/v1/applications/${id}`)
      .set(CSRF)
      .send({ version: view.body.version, form: { ...view.body.form, vehicle: { ...view.body.form.vehicle, motorNo: uniqueSerial('MTX') } } })
      .expect(409);

    const sub = await citizen.post(`/api/v1/applications/${id}/submit`).set(CSRF).expect(200);
    const app = await ctx.owner.application.findUniqueOrThrow({ where: { id } });
    expect((await ctx.owner.fitnessInspection.findMany({ where: { applicationId: id } })).every((i) => i.vehicleId === app.vehicleId)).toBe(true);
    const list = await traffic.agent.get('/api/v1/admin/inspections?status=PASSED').expect(200);
    expect(list.body.find((x: { id: string }) => x.id === r2.body.id)).toMatchObject({ countersigned: true, application: { applicationNumber: sub.body.applicationNumber } });
    const sms = await smsTo(phone);
    expect(sms.some((m) => /চেসিস \S+-এর ফিটনেস পরিদর্শন .*স্থান: নগর ভবন/.test(m))).toBe(true);
    expect(sms.some((m) => m.includes('পরিদর্শনে ১টি') || m.includes('পরিদর্শনে 1টি'))).toBe(true);
    expect(sms.some((m) => m.includes('পরিদর্শনের সময় বাতিল'))).toBe(true);
  });

  it('lets the applicant withdraw an unpaid request, but keeps a paid draft from being deleted', async () => {
    const { agent: citizen } = await loginCitizen(ctx);
    await registerOwner(citizen);
    const id = await readyDraft(ctx, citizen, {}, { certify: false });
    const r1 = await citizen.post(`/api/v1/applications/${id}/fitness-request`).set(CSRF).expect(201);
    const c = await citizen.post(`/api/v1/applications/${id}/fitness-request/cancel`).set(CSRF).expect(200);
    expect(c.body).toMatchObject({ status: 'CANCELLED', invoice: { status: 'CANCELLED' } });
    // Unlocked again: the chassis number can be corrected.
    const cur = await citizen.get(`/api/v1/applications/${id}`).expect(200);
    await citizen
      .patch(`/api/v1/applications/${id}`)
      .set(CSRF)
      .send({ version: cur.body.version, form: { ...cur.body.form, vehicle: { ...cur.body.form.vehicle, chassisNo: uniqueSerial('CHF') } } })
      .expect(200);
    await citizen.post(`/api/v1/applications/${id}/payments/checkout`).set(CSRF).send({ invoiceId: r1.body.invoice.id }).expect(409);

    const r2 = await citizen.post(`/api/v1/applications/${id}/fitness-request`).set(CSRF).expect(201);
    await payViaSimulator(citizen, id, 'SUCCESS', r2.body.invoice.id);
    const paid = await citizen.post(`/api/v1/applications/${id}/fitness-request/cancel`).set(CSRF).expect(409);
    expect(paid.body.error.code).toBe('FITNESS_FEE_ALREADY_PAID');
    const del = await citizen.delete(`/api/v1/applications/${id}`).set(CSRF).expect(409);
    expect(del.body.error.code).toBe('DRAFT_HAS_PAYMENT');
    // Another applicant cannot request or cancel on this draft.
    const other = await loginCitizen(ctx);
    await registerOwner(other.agent);
    await other.agent.post(`/api/v1/applications/${id}/fitness-request`).set(CSRF).expect(404);
    await other.agent.post(`/api/v1/applications/${id}/fitness-request/cancel`).set(CSRF).expect(404);
  });

  it('does not accept a certificate issued for a different chassis', async () => {
    const { agent: citizen } = await loginCitizen(ctx);
    await registerOwner(citizen);
    const id = await readyDraft(ctx, citizen);
    await ctx.owner.fitnessInspection.updateMany({ where: { applicationId: id }, data: { chassisNo: uniqueSerial('OTHER') } });
    const r = await citizen.post(`/api/v1/applications/${id}/submit`).set(CSRF).expect(400);
    expect(r.body.error.code).toBe('FITNESS_CERTIFICATE_REQUIRED');
    await certifyFitness(ctx, id);
    await citizen.post(`/api/v1/applications/${id}/submit`).set(CSRF).expect(200);
  });
});

describe('fees and payments', () => {
  it('creates the Schedule 2 invoice at submission and confirms payment only through a signed, idempotent callback', async () => {
    const { agent: citizen } = await loginCitizen(ctx);
    await registerOwner(citizen);
    const sub = await submitNew(ctx, citizen);
    const v1 = await citizen.get(`/api/v1/applications/${sub.id}`).expect(200);
    expect(v1.body.invoice).toMatchObject({ status: 'UNPAID', totalBdt: 8000, purpose: 'NEW_REGISTRATION' });
    // The fitness fee is paid separately with the inspection request, before submission.
    expect(v1.body.invoice.lines.map((l: { service: string; amountBdt: number }) => [l.service, l.amountBdt])).toEqual([['REGISTRATION', 8000]]);
    expect(v1.body.invoice.invoiceNo).toMatch(/^INV-DSCC-\d{4}-\d{6}$/);

    const fees = ctx.app.get(FeesService);
    const co = await citizen.post(`/api/v1/applications/${sub.id}/payments/checkout`).set(CSRF).expect(201);
    const payload = { city: 'DSCC', sessionId: co.body.sessionId, gatewayTxnId: 'SIMTEST' + Date.now(), amountBdt: 8000, outcome: 'SUCCESS', at: new Date().toISOString() };
    const server = request(ctx.app.getHttpServer());
    await server.post('/api/v1/payments/webhook/simulator').send(payload).expect(401);
    await server.post('/api/v1/payments/webhook/simulator').set('x-payment-signature', 'forged').send(payload).expect(401);
    const sig = fees.signCallback(payload as never);
    await server.post('/api/v1/payments/webhook/simulator').set('x-payment-signature', sig).send({ ...payload, amountBdt: 1 }).expect(401);
    const first = await server.post('/api/v1/payments/webhook/simulator').set('x-payment-signature', sig).send(payload).expect(200);
    expect(first.body.status).toBe('PAID');
    expect(first.body.receiptNo).toMatch(/^RCP-DSCC-\d{4}-\d{6}$/);
    const replay = await server.post('/api/v1/payments/webhook/simulator').set('x-payment-signature', sig).send(payload).expect(200);
    expect(replay.body).toEqual({ status: 'DUPLICATE', receiptNo: first.body.receiptNo });
    const inv = await ctx.owner.invoice.findFirstOrThrow({ where: { applicationId: sub.id } });
    expect(await ctx.owner.payment.count({ where: { invoiceId: inv.id, status: 'SUCCEEDED' } })).toBe(1);
    await citizen.post(`/api/v1/applications/${sub.id}/payments/checkout`).set(CSRF).expect(409);
    // Paying never changes the application status by itself.
    expect((await ctx.owner.application.findUniqueOrThrow({ where: { id: sub.id } })).status).toBe('SUBMITTED');
    await expect(ctx.owner.$executeRawUnsafe(`UPDATE payments SET amount_bdt = 1 WHERE invoice_id = '${inv.id}'`)).rejects.toThrow(/append-only/);

    const other = await loginCitizen(ctx);
    await registerOwner(other.agent);
    await other.agent.post(`/api/v1/applications/${sub.id}/payments/checkout`).set(CSRF).expect(404);
  });

  it('records a declined simulator payment without settling the invoice', async () => {
    const { agent: citizen } = await loginCitizen(ctx);
    await registerOwner(citizen);
    const sub = await submitNew(ctx, citizen);
    const r = await payViaSimulator(citizen, sub.id, 'FAILED');
    expect(r.result.status).toBe('FAILED');
    expect((await citizen.get(`/api/v1/applications/${sub.id}`).expect(200)).body.invoice.status).toBe('UNPAID');
  });

  it('lets a revenue officer record a bank challan once, for the exact amount', async () => {
    const { agent: citizen } = await loginCitizen(ctx);
    await registerOwner(citizen);
    const sub = await submitNew(ctx, citizen);
    const revenue = await officer(ctx, 'REVENUE_OFFICER');
    const list = await revenue.agent.get('/api/v1/admin/invoices?status=UNPAID').expect(200);
    const inv = list.body.find((x: { application: { id: string } }) => x.application.id === sub.id);
    expect(inv.owner.nidMasked).toMatch(/^••••••\d{4}$/);
    const challan = `CH-${Date.now()}`;
    const body = { challanNo: challan, amountBdt: 8000, paidOn: '2026-10-30', bankName: 'সোনালী ব্যাংক' };
    await revenue.agent.post(`/api/v1/admin/invoices/${inv.id}/counter-payment`).set(CSRF).send({ ...body, amountBdt: 9000 }).expect(400);
    await revenue.agent.post(`/api/v1/admin/invoices/${inv.id}/counter-payment`).set(CSRF).send({ ...body, paidOn: '2099-01-01' }).expect(400);
    const ok = await revenue.agent.post(`/api/v1/admin/invoices/${inv.id}/counter-payment`).set(CSRF).send(body).expect(200);
    expect(ok.body.receiptNo).toMatch(/^RCP-/);
    await revenue.agent.post(`/api/v1/admin/invoices/${inv.id}/counter-payment`).set(CSRF).send(body).expect(409);
    const verifier = await officer(ctx, 'VERIFICATION_OFFICER');
    await verifier.agent.post(`/api/v1/admin/invoices/${inv.id}/counter-payment`).set(CSRF).send(body).expect(403);
    const sched = await revenue.agent.get('/api/v1/admin/fee-schedules').expect(200);
    expect(sched.body.filter((r: { service: string }) => r.service === 'RENEWAL').map((r: { amountBdt: number }) => r.amountBdt).sort()).toEqual([4000, 5000]);
  });
});

describe('rejection and appeal (Rule 4(6), 4(7))', () => {
  it('requires written reasons, keeps the quota slot during the appeal window, and lets a different authority decide the appeal', async () => {
    const a = await approvableApplication(ctx, { skip: ['inspection', 'payment'] });
    const decider = await officer(ctx, 'APPROVING_OFFICER');
    await decider.agent.post(`/api/v1/admin/applications/${a.id}/reject`).set(CSRF).send({ reasons: [], reasonText: 'x', totp: stepUp(decider) }).expect(400);
    const rej = await decider.agent
      .post(`/api/v1/admin/applications/${a.id}/reject`)
      .set(CSRF)
      .send({ reasons: ['DOCUMENTS_INVALID'], reasonText: 'মালিকের NID কপি অস্পষ্ট ও স্বাক্ষর মিলছে না।', totp: stepUp(decider) })
      .expect(200);
    expect(rej.body.status).toBe('REJECTED');
    expect(rej.body.appealDeadline > new Date().toISOString().slice(0, 10)).toBe(true);

    const view = await a.citizen.get(`/api/v1/applications/${a.id}`).expect(200);
    expect(view.body.decision).toMatchObject({ decision: 'REJECTED', reasons: ['DOCUMENTS_INVALID'] });
    expect(view.body.canAppeal).toBe(true);
    const quota = await a.citizen.get('/api/v1/owners/me/vehicle-quota').expect(200);
    expect(quota.body.used).toBe(1); // still counted while appealable
    expect((await smsTo(a.phone)).some((m) => m.includes('না-মঞ্জুর') && m.includes('নথি সঠিক নয়'))).toBe(true);

    await a.citizen.post(`/api/v1/applications/${a.id}/appeal`).set(CSRF).send({ grounds: 'ছোট' }).expect(400);
    const ap = await a.citizen.post(`/api/v1/applications/${a.id}/appeal`).set(CSRF).send({ grounds: 'নতুন সত্যায়িত NID কপি জমা দিতে প্রস্তুত, অনুগ্রহ করে পুনর্বিবেচনা করুন।' }).expect(201);
    await a.citizen.post(`/api/v1/applications/${a.id}/appeal`).set(CSRF).send({ grounds: 'নতুন সত্যায়িত NID কপি জমা দিতে প্রস্তুত, অনুগ্রহ করে পুনর্বিবেচনা করুন।' }).expect(409);

    // The rejecting officer, even with the appeal role, cannot hear the appeal.
    const dStaff = await ctx.owner.staffAccount.findFirstOrThrow({ where: { roleAssignments: { some: { roleCode: 'APPROVING_OFFICER' } } }, orderBy: { createdAt: 'desc' } });
    await ctx.owner.roleAssignment.create({ data: { staffId: dStaff.id, roleCode: 'APPEAL_AUTHORITY', cityId: dStaff.cityId } });
    const self = await decider.agent.post(`/api/v1/admin/appeals/${ap.body.id}/decide`).set(CSRF).send({ outcome: 'ALLOWED', note: 'নিজের সিদ্ধান্তের আপিল', totp: stepUp(decider) }).expect(403);
    expect(self.body.error.code).toBe('SEPARATION_OF_DUTIES');

    const authority = await officer(ctx, 'APPEAL_AUTHORITY');
    const pending = await authority.agent.get('/api/v1/admin/appeals?status=PENDING').expect(200);
    expect(pending.body.find((x: { id: string }) => x.id === ap.body.id)).toMatchObject({ rejection: { reasons: ['DOCUMENTS_INVALID'] }, rejectedByMe: false });
    await authority.agent.post(`/api/v1/admin/appeals/${ap.body.id}/decide`).set(CSRF).send({ outcome: 'ALLOWED', note: 'নতুন নথি বিবেচনার যোগ্য।', totp: stepUp(authority) }).expect(200);
    expect((await ctx.owner.application.findUniqueOrThrow({ where: { id: a.id } })).status).toBe('UNDER_VERIFICATION');

    // Second decision: rejected again; this time the appeal is dismissed and the slot is released.
    const decider2 = await officer(ctx, 'APPROVING_OFFICER');
    await decider2.agent
      .post(`/api/v1/admin/applications/${a.id}/reject`)
      .set(CSRF)
      .send({ reasons: ['FALSE_DECLARATION'], reasonText: 'পুনঃযাচাইয়ে ঘোষণার তথ্য অসত্য পাওয়া গেছে।', totp: stepUp(decider2) })
      .expect(200);
    const ap2 = await a.citizen.post(`/api/v1/applications/${a.id}/appeal`).set(CSRF).send({ grounds: 'আমার ঘোষণা সঠিক, প্রমাণসহ শুনানির সুযোগ চাই। অনুগ্রহ করে বিবেচনা করুন।' }).expect(201);
    const authority2 = await officer(ctx, 'APPEAL_AUTHORITY');
    await authority2.agent.post(`/api/v1/admin/appeals/${ap2.body.id}/decide`).set(CSRF).send({ outcome: 'DISMISSED', note: 'প্রমাণ যথেষ্ট নয়, সিদ্ধান্ত বহাল।', totp: stepUp(authority2) }).expect(200);
    const app = await ctx.owner.application.findUniqueOrThrow({ where: { id: a.id } });
    expect(app.rejectionFinalAt).not.toBeNull();
    expect((await ctx.owner.vehicle.findUniqueOrThrow({ where: { id: app.vehicleId! } })).status).toBe('REJECTED');
    expect((await a.citizen.get('/api/v1/owners/me/vehicle-quota').expect(200)).body.used).toBe(0);
    expect((await a.citizen.get(`/api/v1/applications/${a.id}`).expect(200)).body.canAppeal).toBe(false);
  });

  it('finalises a rejection once the appeal window passes without an appeal', async () => {
    const a = await approvableApplication(ctx, { skip: ['inspection', 'payment', 'checks'] });
    const decider = await officer(ctx, 'APPROVING_OFFICER');
    await decider.agent
      .post(`/api/v1/admin/applications/${a.id}/reject`)
      .set(CSRF)
      .send({ reasons: ['OWNER_INELIGIBLE', 'OTHER'], reasonText: 'আবেদনকারী নাগরিকত্বের প্রমাণ দেননি।', totp: stepUp(decider) })
      .expect(200);
    const app = await ctx.owner.application.findUniqueOrThrow({ where: { id: a.id } });
    const dayAfter = new Date(app.appealDeadline!.getTime() + 86_400_000).toISOString().slice(0, 10);
    const n = await ctx.app.get(DecisionService).finalizeExpiredRejections(dayAfter);
    expect(n).toBeGreaterThanOrEqual(1);
    expect((await ctx.owner.application.findUniqueOrThrow({ where: { id: a.id } })).rejectionFinalAt).not.toBeNull();
    expect((await a.citizen.get('/api/v1/owners/me/vehicle-quota').expect(200)).body.used).toBe(0);
    const late = await a.citizen.post(`/api/v1/applications/${a.id}/appeal`).set(CSRF).send({ grounds: 'দেরিতে আপিল করছি, অনুগ্রহ করে বিবেচনা করুন এবং সুযোগ দিন।' }).expect(409);
    expect(late.body.error.code).toBe('APPLICATION_INVALID_STATE');
  });
});

describe('refunds when a rejection becomes final (DSCC decision, 2026-11-02)', () => {
  it('returns every paid fee: online at once, a bank challan once one revenue officer records the bank reference', async () => {
    const a = await approvableApplication(ctx, { fitness: 'api', skip: ['payment'] });
    // Registration fee by bank challan; the fitness fee was paid online before submission.
    const revenue = await officer(ctx, 'REVENUE_OFFICER');
    const reg = await ctx.owner.invoice.findFirstOrThrow({ where: { applicationId: a.id, purpose: 'NEW_REGISTRATION' } });
    await revenue.agent.post(`/api/v1/admin/invoices/${reg.id}/counter-payment`).set(CSRF).send({ challanNo: `CH-RF-${Date.now()}`, amountBdt: 8000, paidOn: '2026-10-30', bankName: 'সোনালী ব্যাংক' }).expect(200);

    const decider = await officer(ctx, 'APPROVING_OFFICER');
    await decider.agent.post(`/api/v1/admin/applications/${a.id}/reject`).set(CSRF).send({ reasons: ['DOCUMENTS_INVALID'], reasonText: 'নথি অস্পষ্ট, পড়া যায় না।', totp: stepUp(decider) }).expect(200);
    // Nothing is refunded while the rejection can still be appealed.
    expect(await ctx.owner.refund.count({ where: { applicationId: a.id } })).toBe(0);
    const app = await ctx.owner.application.findUniqueOrThrow({ where: { id: a.id } });
    const dayAfter = new Date(app.appealDeadline!.getTime() + 86_400_000).toISOString().slice(0, 10);
    await ctx.app.get(DecisionService).finalizeExpiredRejections(dayAfter);
    await ctx.app.get(DecisionService).finalizeExpiredRejections(dayAfter); // idempotent

    const refunds = await ctx.owner.refund.findMany({ where: { applicationId: a.id }, orderBy: { amountBdt: 'asc' } });
    expect(refunds.map((r) => [r.method, r.amountBdt, r.status])).toEqual([
      ['ONLINE_SIMULATOR', 1000, 'COMPLETED'],
      ['COUNTER_CHALLAN', 8000, 'PENDING'],
    ]);
    expect((await ctx.owner.invoice.findUniqueOrThrow({ where: { id: a.fitness!.invoiceId } })).status).toBe('REFUNDED');
    expect((await ctx.owner.invoice.findUniqueOrThrow({ where: { id: reg.id } })).status).toBe('PAID');

    const pending = await revenue.agent.get('/api/v1/admin/refunds?status=PENDING').expect(200);
    const row = pending.body.find((x: { application: { id: string } }) => x.application.id === a.id);
    expect(row).toMatchObject({ amountBdt: 8000, method: 'COUNTER_CHALLAN', invoiceNo: reg.invoiceNo, owner: { nidMasked: expect.stringMatching(/^••••••\d{4}$/) } });
    await revenue.agent.post(`/api/v1/admin/refunds/${row.id}/complete`).set(CSRF).send({ reference: 'x' }).expect(400);
    const verifier = await officer(ctx, 'VERIFICATION_OFFICER');
    await verifier.agent.post(`/api/v1/admin/refunds/${row.id}/complete`).set(CSRF).send({ reference: 'SB-RF-0001' }).expect(403);
    // One officer is enough: no second approval.
    const done = await revenue.agent.post(`/api/v1/admin/refunds/${row.id}/complete`).set(CSRF).send({ reference: 'sb-rf-0001' }).expect(200);
    expect(done.body).toMatchObject({ status: 'COMPLETED', reference: 'SB-RF-0001' });
    await revenue.agent.post(`/api/v1/admin/refunds/${row.id}/complete`).set(CSRF).send({ reference: 'SB-RF-0002' }).expect(409);
    expect((await ctx.owner.invoice.findUniqueOrThrow({ where: { id: reg.id } })).status).toBe('REFUNDED');

    // A completed refund is permanent, and a refund can only return what was paid.
    await expect(ctx.owner.$executeRawUnsafe(`UPDATE refunds SET provider_ref = 'X' WHERE id = '${row.id}'`)).rejects.toThrow(/append-only/);
    await expect(ctx.owner.$executeRawUnsafe(`DELETE FROM refunds WHERE id = '${row.id}'`)).rejects.toThrow(/append-only/);

    const view = await a.citizen.get(`/api/v1/applications/${a.id}`).expect(200);
    expect(view.body.invoice).toMatchObject({ status: 'REFUNDED', refunds: [{ status: 'COMPLETED', amountBdt: 8000, reference: 'SB-RF-0001' }] });
    expect(view.body.fitnessInvoices[0]).toMatchObject({ status: 'REFUNDED', refunds: [{ status: 'COMPLETED', amountBdt: 1000 }] });
    const sms = await smsTo(a.phone);
    expect(sms.some((m) => m.includes('চূড়ান্তভাবে না-মঞ্জুর') && m.includes('9000 টাকা ফেরত'))).toBe(true);
    expect(sms.some((m) => m.includes('8000 টাকা ফেরত দেওয়া হয়েছে') && m.includes('SB-RF-0001'))).toBe(true);
    expect(await ctx.app.get(AuditService).verifyChain()).toBeNull();
  });
});

describe('phase 2 data protection', () => {
  it('keeps new workflow tables city-isolated and append-only for the runtime role', async () => {
    const c = new Client({ connectionString: process.env.DATABASE_URL });
    await c.connect();
    try {
      for (const t of ['invoices', 'payments', 'fitness_inspections', 'application_decisions', 'registrations', 'qr_credentials', 'appeals', 'refunds']) {
        const r = await c.query(`SELECT count(*)::int AS n FROM ${t}`);
        expect(r.rows[0].n, t).toBe(0); // no app.city_id set → nothing visible
      }
      await expect(c.query("UPDATE application_decisions SET reason_text = 'x'")).rejects.toThrow(/permission denied/);
      await expect(c.query("INSERT INTO fee_schedules (id, service, amount_bdt, effective_from, legal_ref) VALUES (gen_random_uuid(), 'FITNESS', 1, '2026-01-01', 'x')")).rejects.toThrow(/permission denied/);
    } finally {
      await c.end();
    }
  });

  it('withdrawing cancels unpaid invoices and an open inspection request', async () => {
    const { agent: citizen } = await loginCitizen(ctx);
    await registerOwner(citizen);
    const sub = await submitNew(ctx, citizen);
    // The certificate expired while the file was pending: a new request is possible after submission too.
    await ctx.owner.fitnessInspection.updateMany({ where: { applicationId: sub.id }, data: { validUntil: new Date(Date.now() - 2 * 86_400_000) } });
    const req = await citizen.post(`/api/v1/applications/${sub.id}/fitness-request`).set(CSRF).expect(201);
    await citizen.post(`/api/v1/applications/${sub.id}/withdraw`).set(CSRF).expect(200);
    expect((await ctx.owner.invoice.findMany({ where: { applicationId: sub.id } })).map((i) => i.status)).toEqual(['CANCELLED', 'CANCELLED']);
    expect((await ctx.owner.fitnessInspection.findUniqueOrThrow({ where: { id: req.body.id } })).status).toBe('CANCELLED');
    void fullForm;
  });
});
