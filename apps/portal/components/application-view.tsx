'use client';

import { DefinitionList, ErrorAlert, Notice, StatusBadge, api, useI18n } from '@dscc/web-ui';
import Link from 'next/link';
import { useState } from 'react';
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
