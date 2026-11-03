'use client';

import { ErrorAlert, InvoiceSummary, Notice, api, useAction, useI18n } from '@dscc/web-ui';
import { useRouter, useSearchParams } from 'next/navigation';
import type { ApplicationDetail } from './types';

/**
 * Fitness before the application (DSCC decision, 2026-11-02): the applicant requests the inspection from
 * the draft, pays the fitness fee, attends the appointment and waits for the certificate before submitting.
 */
export function FitnessCard({ app, onChange, beforeRequest }: { app: ApplicationDetail; onChange: () => Promise<void>; beforeRequest?: () => Promise<void> }) {
  const { t, tk, date } = useI18n();
  const router = useRouter();
  const params = useSearchParams();
  const a = useAction();
  const cert = app.fitness.certificate;
  const open = app.inspections.find((i) => i.id === app.fitness.openInspectionId) ?? null;
  const last = app.inspections[app.inspections.length - 1];
  const payResult = params.get('payment');

  async function request() {
    await a.run(async () => {
      if (beforeRequest) await beforeRequest();
      await api(`/applications/${app.id}/fitness-request`, { method: 'POST' });
      await onChange();
    });
  }
  async function pay(invoiceId: string) {
    const r = await a.run(() => api<{ gatewayUrl: string }>(`/applications/${app.id}/payments/checkout`, { method: 'POST', json: { invoiceId } }));
    if (r) router.push(r.gatewayUrl);
  }
  async function cancel() {
    if (!window.confirm(`${t('fitc.cancel')}?`)) return;
    await a.run(async () => {
      await api(`/applications/${app.id}/fitness-request/cancel`, { method: 'POST' });
      await onChange();
    });
  }

  return (
    <div className="card" data-testid="fitness-card">
      <h2>{t('fitc.title')}</h2>
      {cert ? (
        <Notice kind="success">
          <span data-testid="fitness-certificate">{t('fitc.valid', { no: cert.certificateNo, date: date(cert.validUntil) })}</span>
          <br />
          <span className="small">{t('fitc.vehicle', { chassis: cert.chassisNo, motor: cert.motorNo })}</span>
        </Notice>
      ) : (
        <p className="muted">{t('fitc.note')}</p>
      )}
      {payResult === 'PAID' && open?.invoice?.status === 'PAID' && <Notice kind="success">{tk('cit.payResult.PAID')}</Notice>}
      {payResult === 'FAILED' && open?.invoice?.status === 'UNPAID' && <Notice kind="warning">{tk('cit.payResult.FAILED')}</Notice>}
      {open && (
        <div data-testid="fitness-open">
          <p>
            <span className={`badge badge-${open.status.toLowerCase()}`}>{tk(`inspection.${open.status}`)}</span>{' '}
            <span className="small">{t('fitc.vehicle', { chassis: open.chassisNo, motor: open.motorNo })}</span>
          </p>
          {open.status === 'SCHEDULED' && open.scheduledFor && <p data-testid="fitness-appointment">{t('fitc.scheduled', { date: date(open.scheduledFor, true), place: open.location ?? '' })}</p>}
          {open.status === 'REQUESTED' && <p>{open.invoice?.status === 'UNPAID' ? t('fitc.awaitingPayment') : t('fitc.awaitingAppointment')}</p>}
          {open.invoice && <InvoiceSummary invoice={open.invoice} />}
          {open.status === 'REQUESTED' && open.invoice?.status === 'UNPAID' && (
            <div className="row">
              <button type="button" className="btn" onClick={() => void pay(open.invoice!.id)} disabled={a.busy}>
                {t('fitc.payFee')}
              </button>
              <button type="button" className="btn btn-ghost" onClick={() => void cancel()} disabled={a.busy}>
                {t('fitc.cancel')}
              </button>
            </div>
          )}
        </div>
      )}
      {!open && !cert && last?.status === 'FAILED' && <Notice kind="warning">{t('fitc.failed')}</Notice>}
      {!open && !cert && last?.status === 'PASSED' && !last.countersigned && <Notice>{t('fitc.awaitingCountersign')}</Notice>}
      <ErrorAlert error={a.error} />
      {app.fitness.canRequest && !(last?.status === 'PASSED' && !last.countersigned) && (
        <button type="button" className="btn" onClick={() => void request()} disabled={a.busy}>
          {t('fitc.request')}
        </button>
      )}
    </div>
  );
}
