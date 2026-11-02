'use client';

import { ErrorAlert, Notice, Spinner, api, useAction, useI18n } from '@dscc/web-ui';
import { useParams, useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import { useRequireCitizen } from '../../../../components/session';

interface Session {
  sessionId: string;
  status: string;
  amountBdt: number;
  invoiceNo: string;
  applicationId: string;
}

/**
 * Development payment gateway simulator page. Stands in for the government gateway's hosted checkout
 * until DSCC approves one (Gate D). The outcome is delivered to the API as a signed callback.
 */
export default function SimulatedGateway() {
  const me = useRequireCitizen({ owner: true });
  const { id } = useParams<{ id: string }>();
  const router = useRouter();
  const { t, num } = useI18n();
  const [s, setS] = useState<Session | null>(null);
  const [error, setError] = useState<unknown>(null);
  const a = useAction();
  useEffect(() => {
    if (me) void api<Session>(`/dev/payment-gateway/sessions/${id}`).then(setS).catch(setError);
  }, [me, id]);

  async function complete(outcome: 'SUCCESS' | 'FAILED') {
    const r = await a.run(() => api<{ status: string; applicationId: string }>(`/dev/payment-gateway/sessions/${id}/complete`, { method: 'POST', json: { outcome } }));
    if (r) router.replace(`/applications/${r.applicationId}?payment=${r.status === 'PAID' ? 'PAID' : 'FAILED'}`);
  }

  if (!me) return <Spinner />;
  if (error) return <ErrorAlert error={error} />;
  if (!s) return <Spinner />;
  return (
    <div className="narrow">
      <h1>{t('sim.title')}</h1>
      <Notice kind="warning">{t('sim.note')}</Notice>
      <div className="card">
        <p style={{ fontSize: '1.3rem', fontWeight: 700 }}>{t('sim.amount', { amount: num(s.amountBdt) })}</p>
        <p className="muted">{t('sim.invoice', { no: s.invoiceNo })}</p>
        {s.status !== 'PENDING' ? (
          <Notice>{t('sim.closed')}</Notice>
        ) : (
          <div className="row">
            <button type="button" className="btn" disabled={a.busy} onClick={() => complete('SUCCESS')}>
              {t('sim.pay')}
            </button>
            <button type="button" className="btn btn-secondary" disabled={a.busy} onClick={() => complete('FAILED')}>
              {t('sim.fail')}
            </button>
          </div>
        )}
        <ErrorAlert error={a.error} />
      </div>
    </div>
  );
}
