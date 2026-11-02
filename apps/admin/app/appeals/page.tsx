'use client';

import { ErrorAlert, Field, Notice, Spinner, api, useAction, useI18n } from '@dscc/web-ui';
import Link from 'next/link';
import { FormEvent, useCallback, useEffect, useState } from 'react';
import { TotpField } from '../../components/totp-field';
import { useRequireStaff } from '../../components/session';

interface Row {
  id: string;
  status: string;
  grounds: string;
  filedAt: string;
  decidedAt: string | null;
  decisionNote: string | null;
  rejectedByMe: boolean;
  application: { id: string; applicationNumber: string; status: string };
  owner: { nameBn: string; nidMasked: string } | null;
  rejection: { reasons: string[]; reasonText: string | null; decidedAt: string } | null;
}

const FILTERS = ['PENDING', 'ALLOWED', 'DISMISSED'] as const;

export default function Appeals() {
  const me = useRequireStaff('appeal.read');
  const { t, tk, date } = useI18n();
  const [status, setStatus] = useState<string>('PENDING');
  const [rows, setRows] = useState<Row[] | null>(null);
  const [error, setError] = useState<unknown>(null);
  const load = useCallback(async () => {
    try {
      setRows(await api<Row[]>(`/admin/appeals?status=${status}`));
    } catch (e) {
      setError(e);
    }
  }, [status]);
  useEffect(() => {
    if (me) void load();
  }, [me, load]);
  if (!me) return <Spinner />;
  return (
    <>
      <h1>{t('appeal.title')}</h1>
      <Notice>{t('appeal.note')}</Notice>
      <div className="row" role="group" aria-label={t('admin.filter.status')}>
        {FILTERS.map((f) => (
          <button key={f} type="button" className={f === status ? 'btn' : 'btn btn-secondary'} aria-pressed={f === status} onClick={() => setStatus(f)}>
            {tk(`appealstatus.${f}`)}
          </button>
        ))}
      </div>
      <ErrorAlert error={error} />
      {!rows ? (
        <Spinner />
      ) : rows.length === 0 ? (
        <p className="muted">{t('appeal.empty')}</p>
      ) : (
        rows.map((r) => (
          <article className="card" key={r.id} data-testid="appeal">
            <h2 style={{ marginTop: 0 }}>
              {me.permissions.includes('application.read') ? <Link href={`/applications/${r.application.id}`}>{r.application.applicationNumber}</Link> : r.application.applicationNumber}{' '}
              <span className={`badge badge-${r.status.toLowerCase()}`}>{tk(`appealstatus.${r.status}`)}</span>
            </h2>
            {r.owner && (
              <p className="small muted">
                {r.owner.nameBn} · NID {r.owner.nidMasked} · {date(r.filedAt, true)}
              </p>
            )}
            {r.rejection && (
              <>
                <h3>{t('appeal.rejection')}</h3>
                <p>{r.rejection.reasons.map((x) => tk(`reason.${x}`)).join(', ')}</p>
                {r.rejection.reasonText && <p className="small">{r.rejection.reasonText}</p>}
              </>
            )}
            <h3>{t('appeal.grounds')}</h3>
            <p>{r.grounds}</p>
            {r.decisionNote && <p className="small">{r.decisionNote}</p>}
            {r.status === 'PENDING' && me.permissions.includes('appeal.decide') && (r.rejectedByMe ? <Notice kind="warning">{t('appeal.ownDecision')}</Notice> : <DecideForm id={r.id} onDone={load} />)}
          </article>
        ))
      )}
    </>
  );
}

function DecideForm({ id, onDone }: { id: string; onDone: () => Promise<void> }) {
  const { t } = useI18n();
  const a = useAction();
  const [note, setNote] = useState('');
  const [totp, setTotp] = useState('');
  async function decide(outcome: 'ALLOWED' | 'DISMISSED') {
    await a.run(async () => {
      await api(`/admin/appeals/${id}/decide`, { method: 'POST', json: { outcome, note, totp } });
      await onDone();
    });
  }
  return (
    <form onSubmit={(e: FormEvent) => e.preventDefault()}>
      <Field label={t('appeal.decisionNote')} error={a.fields.note} required>
        {(p) => <textarea {...p} value={note} onChange={(e) => setNote(e.target.value)} />}
      </Field>
      <TotpField value={totp} onChange={setTotp} error={a.fields.totp} />
      <ErrorAlert error={a.error} />
      <div className="row">
        <button type="button" className="btn" disabled={a.busy} onClick={() => decide('ALLOWED')}>
          {t('appeal.allow')}
        </button>
        <button type="button" className="btn btn-danger" disabled={a.busy} onClick={() => window.confirm(`${t('appeal.dismiss')}?`) && decide('DISMISSED')}>
          {t('appeal.dismiss')}
        </button>
      </div>
    </form>
  );
}
