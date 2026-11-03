'use client';

import { FITNESS_ITEMS } from '@dscc/domain';
import { ErrorAlert, Field, Notice, Spinner, ZoneChip, api, useAction, useI18n } from '@dscc/web-ui';
import Link from 'next/link';
import { FormEvent, useCallback, useEffect, useState } from 'react';
import { useRequireStaff } from '../../components/session';

interface Row {
  id: string;
  status: string;
  requestedAt: string;
  scheduledFor: string | null;
  location: string | null;
  invoice: { id: string; invoiceNo: string; status: string; totalBdt: number } | null;
  checklist: Record<string, 'PASS' | 'FAIL'> | null;
  inspectorNote: string | null;
  countersigned: boolean;
  certificateNo: string | null;
  validUntil: string | null;
  inspectedByMe: boolean;
  application: { id: string; applicationNumber: string | null; status: string };
  vehicle: { seatType: string; chassisNo: string; motorNo: string; model: string | null; hasSpeedometer: boolean | null };
  zone: { code: string; nameBn: string; nameEn: string; uiColour: string } | null;
}

const FILTERS = ['REQUESTED', 'SCHEDULED', 'PASSED', 'FAILED', 'CANCELLED'] as const;

export default function Inspections() {
  const me = useRequireStaff('inspection.read');
  const { t, tk, date } = useI18n();
  const [status, setStatus] = useState<string | null>(null);
  const [rows, setRows] = useState<Row[] | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [flash, setFlash] = useState<string | null>(null);
  // Each officer starts on their own work queue: countersigners on passed inspections, schedulers on
  // paid requests waiting for an appointment, inspectors on scheduled ones.
  useEffect(() => {
    if (!me || status !== null) return;
    const has = (p: string) => me.permissions.includes(p);
    setStatus(has('inspection.record') ? 'SCHEDULED' : has('inspection.countersign') ? 'PASSED' : has('inspection.schedule') ? 'REQUESTED' : 'SCHEDULED');
  }, [me, status]);
  const load = useCallback(async () => {
    if (!status) return;
    try {
      setRows(await api<Row[]>(`/admin/inspections?status=${status}`));
    } catch (e) {
      setError(e);
    }
  }, [status]);
  useEffect(() => {
    if (me) void load();
  }, [me, load]);
  const done = useCallback(
    async (msg: string) => {
      setFlash(msg);
      await load();
    },
    [load],
  );
  if (!me || !status) return <Spinner />;
  const can = (p: string) => me.permissions.includes(p);

  return (
    <>
      <h1>{t('insp.title')}</h1>
      <Notice>{t('insp.note')}</Notice>
      <div className="row" role="group" aria-label={t('admin.filter.status')}>
        {FILTERS.map((f) => (
          <button key={f} type="button" className={f === status ? 'btn' : 'btn btn-secondary'} aria-pressed={f === status} onClick={() => {
              setFlash(null);
              setStatus(f);
            }}>
            {tk(`inspection.${f}`)}
          </button>
        ))}
      </div>
      <ErrorAlert error={error} />
      {flash && (
        <Notice kind="success">
          <span data-testid="inspection-flash">{flash}</span>
        </Notice>
      )}
      {!rows ? (
        <Spinner />
      ) : rows.length === 0 ? (
        <p className="muted">{t('insp.empty')}</p>
      ) : (
        rows.map((r) => (
          <article className="card" key={r.id} data-testid="inspection">
            <div className="row spread">
              <h2 style={{ margin: 0 }}>
                {r.application.applicationNumber ? (
                  can('application.read') ? <Link href={`/applications/${r.application.id}`}>{r.application.applicationNumber}</Link> : r.application.applicationNumber
                ) : (
                  t('insp.draftApplication')
                )}{' '}
                <span className={`badge badge-${r.status.toLowerCase()}`}>{tk(`inspection.${r.status}`)}</span>
              </h2>
              <ZoneChip zone={r.zone} />
            </div>
            {r.scheduledFor ? (
              <p>
                {date(r.scheduledFor, true)} · {r.location}
              </p>
            ) : (
              <p className="small muted">{t('insp.requestedAt', { date: date(r.requestedAt, true) })}</p>
            )}
            <p className="small">
              {tk(`seat.${r.vehicle.seatType}`)} · {r.vehicle.model} · {t('vehicle.chassis')}: {r.vehicle.chassisNo} · {t('vehicle.motor')}: {r.vehicle.motorNo}
            </p>
            {r.invoice && (
              <p className="small" data-testid="inspection-fee">
                {t('insp.fee', { no: r.invoice.invoiceNo })} <span className={`badge badge-${r.invoice.status.toLowerCase()}`}>{tk(`invoice.${r.invoice.status}`)}</span>
              </p>
            )}
            {r.checklist && (
              <ul className="gates">
                {FITNESS_ITEMS.map((i) => (
                  <li key={i} className={r.checklist![i] === 'PASS' ? 'ok' : 'no'}>
                    <span className="mark" aria-hidden="true">{r.checklist![i] === 'PASS' ? '✓' : '✗'}</span>
                    {tk(`fit.${i}`)}: {r.checklist![i] === 'PASS' ? t('common.pass') : t('common.fail')}
                  </li>
                ))}
              </ul>
            )}
            {r.inspectorNote && <p className="small">{r.inspectorNote}</p>}
            {r.certificateNo && <Notice kind="success">{t('wf.certificate', { no: r.certificateNo, date: date(r.validUntil) })}</Notice>}
            {r.status === 'REQUESTED' && can('inspection.schedule') && (r.invoice && r.invoice.status !== 'PAID' ? <p className="muted small">{t('insp.awaitingFee')}</p> : <ScheduleForm row={r} onDone={done} />)}
            {r.status === 'SCHEDULED' && can('inspection.record') && <ResultForm row={r} onDone={done} />}
            {r.status === 'SCHEDULED' && can('inspection.schedule') && <CancelButton id={r.id} onDone={load} />}
            {r.status === 'PASSED' && !r.countersigned && can('inspection.countersign') && <Countersign row={r} onDone={done} />}
            {r.status === 'PASSED' && !r.countersigned && !can('inspection.countersign') && <p className="muted small">{t('wf.awaitingCountersign')}</p>}
          </article>
        ))
      )}
    </>
  );
}

function rowLabel(row: Row, t: ReturnType<typeof useI18n>['t']): string {
  return row.application.applicationNumber ?? `${t('vehicle.chassis')} ${row.vehicle.chassisNo}`;
}

/** Give a paid request its appointment (Dhaka time). */
function ScheduleForm({ row, onDone }: { row: Row; onDone: (msg: string) => Promise<void> }) {
  const { t } = useI18n();
  const a = useAction();
  const [when, setWhen] = useState('');
  const [where, setWhere] = useState('');
  async function submit(e: FormEvent) {
    e.preventDefault();
    await a.run(async () => {
      // datetime-local has no zone; officers schedule in Dhaka time (UTC+6).
      const scheduledFor = when ? new Date(`${when}:00+06:00`).toISOString() : '';
      await api(`/admin/inspections/${row.id}/schedule`, { method: 'POST', json: { scheduledFor, location: where } });
      await onDone(`${rowLabel(row, t)}: ${t('wf.inspectionScheduled')}`);
    });
  }
  return (
    <form onSubmit={submit} className="card" data-testid="schedule-form">
      <h3>{t('wf.inspectionSchedule')}</h3>
      <div className="grid2">
        <Field label={t('wf.inspectionWhen')} error={a.fields.scheduledFor} required>
          {(p) => <input {...p} type="datetime-local" value={when} onChange={(e) => setWhen(e.target.value)} />}
        </Field>
        <Field label={t('wf.inspectionWhere')} error={a.fields.location} required>
          {(p) => <input {...p} type="text" value={where} onChange={(e) => setWhere(e.target.value)} />}
        </Field>
      </div>
      <ErrorAlert error={a.error} />
      <button className="btn" disabled={a.busy}>
        {t('wf.inspectionSchedule')}
      </button>
    </form>
  );
}

function ResultForm({ row, onDone }: { row: Row; onDone: (msg: string) => Promise<void> }) {
  const { t, tk } = useI18n();
  const a = useAction();
  const [checklist, setChecklist] = useState<Record<string, 'PASS' | 'FAIL' | ''>>(Object.fromEntries(FITNESS_ITEMS.map((i) => [i, ''])));
  const [note, setNote] = useState('');
  async function submit(e: FormEvent) {
    e.preventDefault();
    await a.run(async () => {
      const r = await api<{ status: string }>(`/admin/inspections/${row.id}/result`, { method: 'POST', json: { checklist, note: note || undefined } });
      await onDone(`${rowLabel(row, t)}: ${t('insp.saved')} (${tk(`inspection.${r.status}`)})`);
    });
  }
  return (
    <details>
      <summary>
        <strong>{t('insp.record')}</strong>
      </summary>
      <form onSubmit={submit}>
        {FITNESS_ITEMS.map((i) => (
          <fieldset key={i} className="checkrow">
            <legend className="sr-only">{tk(`fit.${i}`)}</legend>
            <span aria-hidden="true">{tk(`fit.${i}`)}</span>
            <div className="pillset">
              {(['PASS', 'FAIL'] as const).map((v) => (
                <label key={v}>
                  <input type="radio" name={`${row.id}-${i}`} checked={checklist[i] === v} onChange={() => setChecklist((c) => ({ ...c, [i]: v }))} />
                  {v === 'PASS' ? t('common.pass') : t('common.fail')}
                </label>
              ))}
            </div>
          </fieldset>
        ))}
        <Field label={t('common.note')}>{(p) => <textarea {...p} value={note} onChange={(e) => setNote(e.target.value)} />}</Field>
        <ErrorAlert error={a.error} />
        <button className="btn" disabled={a.busy || FITNESS_ITEMS.some((i) => !checklist[i])}>
          {t('insp.save')}
        </button>
      </form>
    </details>
  );
}

function Countersign({ row, onDone }: { row: Row; onDone: (msg: string) => Promise<void> }) {
  const { t } = useI18n();
  const a = useAction();
  if (row.inspectedByMe) return <p className="muted small">{t('insp.ownInspection')}</p>;
  return (
    <>
      <button
        type="button"
        className="btn"
        disabled={a.busy}
        onClick={() =>
          a.run(async () => {
            const r = await api<{ certificateNo: string }>(`/admin/inspections/${row.id}/countersign`, { method: 'POST' });
            await onDone(`${rowLabel(row, t)}: ${t('insp.signed', { no: r.certificateNo })}`);
          })
        }
      >
        {t('insp.countersign')}
      </button>
      <ErrorAlert error={a.error} />
    </>
  );
}

function CancelButton({ id, onDone }: { id: string; onDone: () => Promise<void> }) {
  const { t } = useI18n();
  const a = useAction();
  return (
    <>
      <button
        type="button"
        className="btn btn-ghost"
        disabled={a.busy}
        onClick={() => {
          if (!window.confirm(`${t('insp.cancel')}?`)) return;
          void a.run(async () => {
            await api(`/admin/inspections/${id}/cancel`, { method: 'POST' });
            await onDone();
          });
        }}
      >
        {t('insp.cancel')}
      </button>
      <ErrorAlert error={a.error} />
    </>
  );
}
