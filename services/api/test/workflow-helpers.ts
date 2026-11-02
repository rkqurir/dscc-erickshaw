import { totpAt } from '../src/platform/totp';
import { Agent, CSRF, TestCtx, loginCitizen, loginStaff, registerOwner, submitNew } from './helpers';

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

export async function payViaSimulator(citizen: Agent, appId: string, outcome: 'SUCCESS' | 'FAILED' = 'SUCCESS') {
  const co = await citizen.post(`/api/v1/applications/${appId}/payments/checkout`).set(CSRF).expect(201);
  const r = await citizen.post(`/api/v1/dev/payment-gateway/sessions/${co.body.sessionId}/complete`).set(CSRF).send({ outcome }).expect(200);
  return { checkout: co.body, result: r.body };
}

/**
 * Take a fresh application through verification, fitness inspection + countersignature and payment,
 * leaving it UNDER_VERIFICATION with every approval gate met.
 */
export async function approvableApplication(ctx: TestCtx, opts: { verifier?: Officer; skip?: ('checks' | 'inspection' | 'payment')[] } = {}) {
  const { agent: citizen, phone } = await loginCitizen(ctx);
  const nid = await registerOwner(citizen);
  const sub = await submitNew(ctx, citizen);
  const verifier = opts.verifier ?? (await officer(ctx, 'VERIFICATION_OFFICER'));
  await verifier.agent.post(`/api/v1/admin/applications/${sub.id}/start-verification`).set(CSRF).expect(200);
  if (!opts.skip?.includes('checks')) {
    for (const item of VERIFICATION_ITEMS) {
      await verifier.agent.post(`/api/v1/admin/applications/${sub.id}/checks`).set(CSRF).send({ item, result: 'PASS' }).expect(201);
    }
  }
  if (!opts.skip?.includes('inspection')) {
    const ins = await verifier.agent
      .post(`/api/v1/admin/applications/${sub.id}/inspections`)
      .set(CSRF)
      .send({ scheduledFor: new Date(Date.now() + 86_400_000).toISOString(), location: 'DSCC পরিদর্শন কেন্দ্র, নগর ভবন' })
      .expect(201);
    const inspector = await officer(ctx, 'INSPECTION_OFFICER');
    await inspector.agent.post(`/api/v1/admin/inspections/${ins.body.id}/result`).set(CSRF).send({ checklist: ALL_PASS }).expect(200);
    const traffic = await officer(ctx, 'TRAFFIC_COUNTERSIGNER');
    await traffic.agent.post(`/api/v1/admin/inspections/${ins.body.id}/countersign`).set(CSRF).expect(200);
  }
  if (!opts.skip?.includes('payment')) await payViaSimulator(citizen, sub.id);
  return { citizen, phone, nid, ...sub, verifier };
}
