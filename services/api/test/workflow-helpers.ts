import { totpAt } from '../src/platform/totp';
import { Agent, CSRF, TestCtx, loginCitizen, loginStaff, readyDraft, registerOwner } from './helpers';

export const VERIFICATION_ITEMS = ['OWNER_IDENTITY', 'OWNER_ELIGIBILITY', 'VEHICLE_PHOTOS', 'CHASSIS_MOTOR', 'DRIVER_DOCUMENTS', 'ZONE_WARD'];
export const ALL_PASS = { BRAKES: 'PASS', LIGHTING: 'PASS', HORN: 'PASS', SPEED_GOVERNOR: 'PASS', CHASSIS_BODY: 'PASS', SPEEDOMETER: 'PASS' };

export interface Officer {
  agent: Agent;
  secret: string;
}

/** Login already used the current TOTP step; a step-up needs the next one (accepted within ±1 step drift). */
export function stepUp(o: Officer): string {
  return totpAt(o.secret, Date.now() + 30_000);
}

export async function officer(ctx: TestCtx, roleCode: string, zoneCode?: string): Promise<Officer> {
  const s = await loginStaff(ctx, { roleCode, zoneCode });
  return { agent: s.agent, secret: s.secret };
}

export async function payViaSimulator(citizen: Agent, appId: string, outcome: 'SUCCESS' | 'FAILED' = 'SUCCESS', invoiceId?: string) {
  const co = await citizen.post(`/api/v1/applications/${appId}/payments/checkout`).set(CSRF).send(invoiceId ? { invoiceId } : {}).expect(201);
  const r = await citizen.post(`/api/v1/dev/payment-gateway/sessions/${co.body.sessionId}/complete`).set(CSRF).send({ outcome }).expect(200);
  return { checkout: co.body, result: r.body };
}

export const tomorrow = () => new Date(Date.now() + 86_400_000).toISOString();

/**
 * The fitness flow from the draft (DSCC decision, 2026-11-02): the citizen requests and pays, an officer
 * gives the appointment, an inspector records a pass and a different traffic officer countersigns.
 */
export async function fitnessViaApi(ctx: TestCtx, citizen: Agent, appId: string) {
  const req = await citizen.post(`/api/v1/applications/${appId}/fitness-request`).set(CSRF).expect(201);
  await payViaSimulator(citizen, appId, 'SUCCESS', req.body.invoice.id);
  const scheduler = await officer(ctx, 'VERIFICATION_OFFICER');
  await scheduler.agent.post(`/api/v1/admin/inspections/${req.body.id}/schedule`).set(CSRF).send({ scheduledFor: tomorrow(), location: 'DSCC পরিদর্শন কেন্দ্র, নগর ভবন' }).expect(200);
  const inspector = await officer(ctx, 'INSPECTION_OFFICER');
  await inspector.agent.post(`/api/v1/admin/inspections/${req.body.id}/result`).set(CSRF).send({ checklist: ALL_PASS }).expect(200);
  const traffic = await officer(ctx, 'TRAFFIC_COUNTERSIGNER');
  const cert = await traffic.agent.post(`/api/v1/admin/inspections/${req.body.id}/countersign`).set(CSRF).expect(200);
  return { inspectionId: req.body.id as string, invoiceId: req.body.invoice.id as string, certificateNo: cert.body.certificateNo as string };
}

/**
 * Take a fresh application through the fitness certificate, submission, verification and payment, leaving it
 * UNDER_VERIFICATION with every approval gate met. `fitness: 'api'` runs the whole inspection flow; the
 * default inserts the certificate as a fixture. Skipping 'inspection' expires the certificate after submission.
 */
export async function approvableApplication(ctx: TestCtx, opts: { verifier?: Officer; skip?: ('checks' | 'inspection' | 'payment')[]; fitness?: 'api' | 'fixture' } = {}) {
  const { agent: citizen, phone } = await loginCitizen(ctx);
  const nid = await registerOwner(citizen);
  const draftId = await readyDraft(ctx, citizen, {}, { certify: opts.fitness !== 'api' });
  const fitness = opts.fitness === 'api' ? await fitnessViaApi(ctx, citizen, draftId) : null;
  const submitted = await citizen.post(`/api/v1/applications/${draftId}/submit`).set(CSRF).expect(200);
  const sub = { id: draftId, applicationNumber: submitted.body.applicationNumber as string };
  if (opts.skip?.includes('inspection')) {
    await ctx.owner.fitnessInspection.updateMany({ where: { applicationId: sub.id }, data: { validUntil: new Date(Date.now() - 2 * 86_400_000) } });
  }
  const verifier = opts.verifier ?? (await officer(ctx, 'VERIFICATION_OFFICER'));
  await verifier.agent.post(`/api/v1/admin/applications/${sub.id}/start-verification`).set(CSRF).expect(200);
  if (!opts.skip?.includes('checks')) {
    for (const item of VERIFICATION_ITEMS) {
      await verifier.agent.post(`/api/v1/admin/applications/${sub.id}/checks`).set(CSRF).send({ item, result: 'PASS' }).expect(201);
    }
  }
  if (!opts.skip?.includes('payment')) await payViaSimulator(citizen, sub.id);
  return { citizen, phone, nid, ...sub, verifier, fitness };
}
