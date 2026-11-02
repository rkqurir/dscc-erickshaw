'use client';

import { DefinitionList, ErrorAlert, Field, InvoiceSummary, Notice, PlateView, StatusBadge, api, useAction, useI18n } from '@dscc/web-ui';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { FormEvent, useState } from 'react';
import type { ApplicationDetail } from './types';

export function ApplicationView({ app, onChange }: { app: ApplicationDetail; onChange: () => Promise<void> }) {
  const { t, tk, date } = useI18n();
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const [withdrawn, setWithdrawn] = useState(false);
  const v = (app.form.vehicle ?? {}) as Record<string, string | number | boolean>;
  const d = (app.form.driver ?? {}) as Record<string, string>;
  const l = (app.form.location ?? {}) as Record<string, string>;
  const canWithdraw = ['SUBMITTED', 'UNDER_VERIFICATION', 'CORRECTION_REQUESTED'].includes(app.status);

  async function withdraw() {
    if (!window.confirm(t('view.withdrawConfirm'))) return;
    setBusy(true);
    setError(null);
    try {
      await api(`/applications/${app.id}/withdraw`, { method: 'POST' });
      setWithdrawn(true);
      await onChange();
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <p>
        <Link href="/dashboard">← {t('dash.title')}</Link>
      </p>
      {app.status === 'SUBMITTED' && (
        <div className="card" style={{ borderColor: 'var(--brand)' }}>
          <h1>{t('submitted.title')}</h1>
          <DefinitionList
            rows={[
              [t('submitted.number'), <strong key="n" data-testid="application-number">{app.applicationNumber}</strong>],
              [t('view.submittedAt'), date(app.submittedAt, true)],
              [t('submitted.due'), date(app.decisionDueDate)],
            ]}
          />
        </div>
      )}
      {app.status !== 'SUBMITTED' && (
        <h1>
          {app.applicationNumber} <StatusBadge status={app.status} />
        </h1>
      )}
      {withdrawn && <Notice kind="success">{t('view.withdrawn')}</Notice>}
      <ErrorAlert error={error} />

      {app.registration && <RegistrationCard reg={app.registration} />}
      {app.status === 'REJECTED' && app.decision && <RejectionCard app={app} onChange={onChange} />}
      {app.invoice && <FeeCard app={app} />}
      {app.inspections.length > 0 && (
        <div className="card">
          <h2>{t('cit.inspectionTitle')}</h2>
          <ul>
            {app.inspections.map((i) => (
              <li key={i.id}>
                <span className={`badge badge-${i.status.toLowerCase()}`}>{tk(`inspection.${i.status}`)}</span> {t('cit.inspectionAt', { date: date(i.scheduledFor, true), place: i.location })}
                {i.certificateNo && <div className="small">{t('wf.certificate', { no: i.certificateNo, date: date(i.validUntil) })}</div>}
              </li>
            ))}
          </ul>
        </div>
      )}

      <div className="card">
        <h2>{t('view.summary')}</h2>
        <DefinitionList
          rows={[
            [t('dash.col.status'), <StatusBadge key="s" status={app.status} />],
            [t('vehicle.seatType'), v.seatType ? tk(`seat.${v.seatType}`) : null],
            [t('vehicle.chassis'), v.chassisNo as string],
            [t('vehicle.motor'), v.motorNo as string],
            [t('vehicle.year'), v.manufactureYear as number],
            [t('vehicle.battery'), v.batteryType ? tk(`battery.${v.batteryType}`) : null],
            [t('location.charging'), l.chargingLocation],
            [t('driver.nameBn'), d.nameBn],
            [t('driver.phone'), d.phone],
          ]}
        />
      </div>

      <div className="card">
        <h2>{t('view.documents')}</h2>
        <ul>
          {app.documents.map((doc) => (
            <li key={doc.id}>
              <a href={`/api/v1/applications/${app.id}/documents/${doc.id}/file`} target="_blank" rel="noopener noreferrer">
                {tk(`doc.${doc.docType}`)}
              </a>{' '}
              <span className="muted small">({doc.originalName})</span>
            </li>
          ))}
        </ul>
      </div>

      <div className="card">
        <h2>{t('view.timeline')}</h2>
        <ol className="timeline">
          {app.timeline.map((e, i) => (
            <li key={i}>
              <StatusBadge status={e.toStatus} /> <span className="muted small">{date(e.at, true)} · {tk(`actor.${e.actorType}`)}</span>
              {e.note && <p>{e.note}</p>}
            </li>
          ))}
        </ol>
      </div>

      {canWithdraw && (
        <button type="button" className="btn btn-danger" onClick={withdraw} disabled={busy}>
          {t('view.withdraw')}
        </button>
      )}
    </>
  );
}

function FeeCard({ app }: { app: ApplicationDetail }) {
  const { t, tk } = useI18n();
  const router = useRouter();
  const params = useSearchParams();
  const a = useAction();
  const inv = app.invoice!;
  const payResult = params.get('payment');
  const canPay = inv.status === 'UNPAID' && ['SUBMITTED', 'UNDER_VERIFICATION', 'CORRECTION_REQUESTED'].includes(app.status);
  async function pay() {
    const r = await a.run(() => api<{ gatewayUrl: string }>(`/applications/${app.id}/payments/checkout`, { method: 'POST' }));
    if (r) router.push(r.gatewayUrl);
  }
  return (
    <div className="card" data-testid="fee-card">
      <h2>{t('cit.feeTitle')}</h2>
      {payResult === 'PAID' && inv.status === 'PAID' && <Notice kind="success">{tk('cit.payResult.PAID')}</Notice>}
      {payResult === 'FAILED' && inv.status !== 'PAID' && <Notice kind="warning">{tk('cit.payResult.FAILED')}</Notice>}
      <InvoiceSummary invoice={inv} />
      <ErrorAlert error={a.error} />
      {canPay && (
        <button type="button" className="btn" onClick={pay} disabled={a.busy}>
          {t('cit.payNow')}
        </button>
      )}
    </div>
  );
}

function RejectionCard({ app, onChange }: { app: ApplicationDetail; onChange: () => Promise<void> }) {
  const { t, tk, date } = useI18n();
  const a = useAction();
  const [grounds, setGrounds] = useState('');
  const d = app.decision!;
  async function submit(e: FormEvent) {
    e.preventDefault();
    await a.run(async () => {
      await api(`/applications/${app.id}/appeal`, { method: 'POST', json: { grounds } });
      await onChange();
    });
  }
  return (
    <div className="card" style={{ borderColor: 'var(--danger)' }} data-testid="rejection">
      <h2>{t('cit.decisionRejected')}</h2>
      <DefinitionList
        rows={[
          [t('cit.reasons'), d.reasons.map((r) => tk(`reason.${r}`)).join(', ')],
          [t('common.note'), d.reasonText],
        ]}
      />
      {app.appeal && (
        <p>
          {t('cit.appealStatus', { status: tk(`appealstatus.${app.appeal.status}`) })}
          {app.appeal.decisionNote && <span className="small"> — {app.appeal.decisionNote}</span>}
        </p>
      )}
      {app.rejectionFinal && <p className="small">{t('wf.rejectionFinal')}</p>}
      {app.canAppeal && app.appealDeadline && (
        <form onSubmit={submit}>
          <h3>{t('cit.appealTitle')}</h3>
          <p className="small">{t('cit.appealHelp', { date: date(app.appealDeadline) })}</p>
          <Field label={t('appeal.grounds')} error={a.fields.grounds} required>
            {(p) => <textarea {...p} value={grounds} onChange={(e) => setGrounds(e.target.value)} />}
          </Field>
          <ErrorAlert error={a.error} />
          <button className="btn" disabled={a.busy}>
            {t('cit.appealSubmit')}
          </button>
        </form>
      )}
    </div>
  );
}

function RegistrationCard({ reg }: { reg: NonNullable<ApplicationDetail['registration']> }) {
  const { t, tk, date } = useI18n();
  const verifyPath = reg.qr ? `/v/${reg.qr.url.split('/v/')[1]}` : null;
  return (
    <div className="card" style={{ borderColor: 'var(--brand)' }} data-testid="registration">
      <h2>{t('cit.registrationTitle')}</h2>
      <div className="grid2">
        <div>
          <PlateView textBn={reg.plateTextBn} systemId={reg.plateSystemId} background={reg.zone.plateBackgroundColour} />
          <DefinitionList
            rows={[
              [t('dash.col.status'), tk(`regstatus.${reg.status}`)],
              [t('reg.registeredOn'), date(reg.registeredOn)],
              [t('reg.validUntil'), date(reg.validUntil)],
              [t('reg.endOfLife'), date(reg.endOfLifeOn)],
            ]}
          />
        </div>
        {reg.qr && (
          <div>
            <h3>{t('reg.qr', { version: reg.qr.version })}</h3>
            <div className="qr-box">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={reg.qr.qrDataUrl} alt={t('reg.qr', { version: reg.qr.version })} width={220} height={220} />
            </div>
            <p className="small">{t('cit.qrHelp')}</p>
            {verifyPath && (
              <a href={verifyPath} target="_blank" rel="noopener noreferrer">
                {t('cit.qrOpen')}
              </a>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
