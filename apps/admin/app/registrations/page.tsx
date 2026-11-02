'use client';

import { DefinitionList, ErrorAlert, Field, Notice, PlateView, Spinner, ZoneChip, api, useAction, useI18n } from '@dscc/web-ui';
import Link from 'next/link';
import { FormEvent, useCallback, useEffect, useState } from 'react';
import { TotpField } from '../../components/totp-field';
import { useRequireStaff } from '../../components/session';

interface QueueRow {
  applicationId: string;
  applicationNumber: string;
  decidedAt: string | null;
  owner: { nameBn: string; nidMasked: string } | null;
  zone: { code: string; nameBn: string; nameEn: string; uiColour: string } | null;
  registration: { id: string; plateSystemId: string; plateTextBn: string; status: string; issuedAt: string } | null;
}
interface RegDetail {
  id: string;
  plateSystemId: string;
  plateTextBn: string;
  registeredOn: string;
  validUntil: string;
  endOfLifeOn: string;
  status: string;
  zone?: { plateBackgroundColour: string };
  qr: { version: number; url: string; qrDataUrl: string } | null;
}

export default function Registrations() {
  const me = useRequireStaff('registration.read');
  const { t } = useI18n();
  const [rows, setRows] = useState<QueueRow[] | null>(null);
  const [error, setError] = useState<unknown>(null);
  const load = useCallback(async () => {
    try {
      setRows(await api<QueueRow[]>('/admin/registrations/queue'));
    } catch (e) {
      setError(e);
    }
  }, []);
  useEffect(() => {
    if (me) void load();
  }, [me, load]);
  if (!me) return <Spinner />;
  return (
    <>
      <h1>{t('reg.title')}</h1>
      <Notice>{t('reg.note')}</Notice>
      <ErrorAlert error={error} />
      {!rows ? <Spinner /> : rows.length === 0 ? <p className="muted">{t('reg.empty')}</p> : rows.map((r) => <RegCard key={r.applicationId} row={r} canIssue={me.permissions.includes('registration.issue')} canOpen={me.permissions.includes('application.read')} onDone={load} />)}
    </>
  );
}

function RegCard({ row, canIssue, canOpen, onDone }: { row: QueueRow; canIssue: boolean; canOpen: boolean; onDone: () => Promise<void> }) {
  const { t, tk, date } = useI18n();
  const [detail, setDetail] = useState<RegDetail | null>(null);
  const issue = useAction();
  const reissue = useAction();
  const view = useAction();
  const [totp, setTotp] = useState('');
  const [totp2, setTotp2] = useState('');
  const [reason, setReason] = useState('LOST');

  async function doIssue(e: FormEvent) {
    e.preventDefault();
    const r = await issue.run(() => api<RegDetail>(`/admin/applications/${row.applicationId}/registration`, { method: 'POST', json: { totp } }), (x) => t('reg.issued', { plate: x.plateTextBn }));
    if (r) {
      setDetail(r);
      await onDone();
    }
  }
  async function doReissue(e: FormEvent) {
    e.preventDefault();
    if (!row.registration) return;
    const r = await reissue.run(() => api<RegDetail>(`/admin/registrations/${row.registration!.id}/reissue-qr`, { method: 'POST', json: { reason, totp: totp2 } }), (x) => t('reg.reissued', { version: x.qr?.version ?? '' }));
    if (r) setDetail((d) => ({ ...(d ?? r), qr: r.qr }));
  }

  return (
    <article className="card" data-testid="registration-card">
      <div className="row spread">
        <h2 style={{ margin: 0 }}>{canOpen ? <Link href={`/applications/${row.applicationId}`}>{row.applicationNumber}</Link> : row.applicationNumber}</h2>
        <ZoneChip zone={row.zone} />
      </div>
      {row.owner && (
        <p className="small muted">
          {row.owner.nameBn} · NID {row.owner.nidMasked} · {date(row.decidedAt)}
        </p>
      )}
      {!row.registration && !detail && (
        <>
          <span className="badge badge-pending">{t('reg.waiting')}</span>
          {canIssue && (
            <form onSubmit={doIssue}>
              <TotpField value={totp} onChange={setTotp} error={issue.fields.totp} />
              <ErrorAlert error={issue.error} />
              <button className="btn" disabled={issue.busy}>
                {t('reg.issue')}
              </button>
            </form>
          )}
        </>
      )}
      {issue.done && <Notice kind="success">{issue.done}</Notice>}
      {(row.registration || detail) && !detail && (
        <>
          <p>
            <strong>{row.registration!.plateTextBn}</strong> · {row.registration!.plateSystemId} <span className="badge badge-active">{tk(`regstatus.${row.registration!.status}`)}</span>
          </p>
          <button type="button" className="btn btn-secondary" disabled={view.busy} onClick={() => view.run(async () => setDetail(await api<RegDetail>(`/admin/applications/${row.applicationId}/registration`)))}>
            {t('common.view')}
          </button>
          <ErrorAlert error={view.error} />
        </>
      )}
      {detail && (
        <div className="grid2">
          <div>
            <PlateView textBn={detail.plateTextBn} systemId={detail.plateSystemId} background={detail.zone?.plateBackgroundColour ?? row.zone?.uiColour ?? '#1B5E20'} />
            <DefinitionList
              rows={[
                [t('reg.registeredOn'), date(detail.registeredOn)],
                [t('reg.validUntil'), date(detail.validUntil)],
                [t('reg.endOfLife'), date(detail.endOfLifeOn)],
              ]}
            />
          </div>
          {detail.qr && (
            <div>
              <h3>{t('reg.qr', { version: detail.qr.version })}</h3>
              <div className="qr-box">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src={detail.qr.qrDataUrl} alt={t('reg.qr', { version: detail.qr.version })} width={220} height={220} />
              </div>
              {canIssue && (
                <form onSubmit={doReissue}>
                  <h4>{t('reg.reissue')}</h4>
                  <Field label={t('reg.reissueReason')} required>
                    {(p) => (
                      <select {...p} value={reason} onChange={(e) => setReason(e.target.value)}>
                        {['LOST', 'DAMAGED', 'COMPROMISED', 'OTHER'].map((r) => (
                          <option key={r} value={r}>
                            {tk(`reissue.${r}`)}
                          </option>
                        ))}
                      </select>
                    )}
                  </Field>
                  <TotpField value={totp2} onChange={setTotp2} error={reissue.fields.totp} />
                  <ErrorAlert error={reissue.error} />
                  {reissue.done && <Notice kind="success">{reissue.done}</Notice>}
                  <button className="btn btn-danger" disabled={reissue.busy}>
                    {t('reg.reissue')}
                  </button>
                </form>
              )}
            </div>
          )}
        </div>
      )}
    </article>
  );
}
