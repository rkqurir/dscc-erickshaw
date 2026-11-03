'use client';

import { CORRECTION_SECTIONS, DOCUMENT_TYPE_LIST, REJECTION_REASONS, VERIFICATION_ITEMS } from '@dscc/domain';
import { DefinitionList, ErrorAlert, Field, InvoiceSummary as InvoiceView, Notice, Spinner, api, useAction, useI18n } from '@dscc/web-ui';
import { FormEvent, useCallback, useEffect, useState } from 'react';
import { TotpField } from './totp-field';

interface Inspection {
  id: string;
  status: string;
  chassisNo: string;
  requestedAt: string;
  scheduledFor: string | null;
  location: string | null;
  checklist: Record<string, 'PASS' | 'FAIL'> | null;
  inspectorNote: string | null;
  countersigned: boolean;
  certificateNo: string | null;
  validUntil: string | null;
}
interface Invoice {
  invoiceNo: string;
  status: string;
  totalBdt: number;
  lines: { service: string; amountBdt: number; legalRef: string }[];
  payments: { method: string; reference: string; amountBdt: number; status: string; receiptNo: string | null; at: string }[];
}
export interface Workflow {
  id: string;
  status: string;
  verifiedBy: { name: string | null; isMe: boolean } | null;
  appealDeadline: string | null;
  rejectionFinal: boolean;
  gates: { gate: string; ok: boolean }[];
  unmet: string[];
  detail: { checklist: Record<string, 'PASS' | 'FAIL' | null> };
  checks: { item: string; result: string; note: string | null; by: string | null; at: string }[];
  corrections: { id: string; items: string[]; message: string; at: string; resolvedAt: string | null }[];
  inspections: Inspection[];
  invoice: Invoice | null;
  decisions: { decision: string; reasons: string[]; reasonText: string | null; by: string | null; at: string }[];
  appeals: { id: string; status: string; grounds: string; filedAt: string; decisionNote: string | null }[];
  registration: { id: string; plateSystemId: string; plateTextBn: string; validUntil: string; status: string } | null;
  can: { startVerification: boolean; check: boolean; requestCorrection: boolean; decide: boolean; approve: boolean };
}

export { InvoiceSummary as InvoiceView } from '@dscc/web-ui';

export function WorkflowPanel({ id, onChanged }: { id: string; onChanged: () => void }) {
  const { t, tk, date } = useI18n();
  const [wf, setWf] = useState<Workflow | null>(null);
  const [loadError, setLoadError] = useState<unknown>(null);
  // Outcome of the last decision; the decision forms disappear once the status changes.
  const [flash, setFlash] = useState<string | null>(null);
  const load = useCallback(async () => {
    try {
      setWf(await api<Workflow>(`/admin/applications/${id}/workflow`));
    } catch (e) {
      setLoadError(e);
    }
  }, [id]);
  useEffect(() => {
    void load();
  }, [load]);

  const refresh = async () => {
    await load();
    onChanged();
  };

  if (loadError) return <ErrorAlert error={loadError} />;
  if (!wf) return <Spinner />;

  return (
    <section className="card" aria-labelledby="wf-title" data-testid="workflow">
      <h2 id="wf-title">{t('wf.title')}</h2>
      {wf.verifiedBy && <p className="muted small">{t('wf.verifiedBy', { name: wf.verifiedBy.name ?? '—' })}</p>}
      {wf.can.startVerification && <StartVerification id={id} onDone={refresh} />}

      <div className="grid2">
        <div>
          <h3>{t('wf.gates')}</h3>
          <ul className="gates" data-testid="gates">
            {wf.gates.map((g) => (
              <li key={g.gate} className={g.ok ? 'ok' : 'no'}>
                <span className="mark" aria-hidden="true">{g.ok ? '✓' : '✗'}</span>
                <span>
                  {tk(`gate.${g.gate}`)} <span className="sr-only">({g.ok ? t('common.done') : t('common.pending')})</span>
                </span>
              </li>
            ))}
          </ul>
        </div>
        <div>
          <h3>{t('wf.checklist')}</h3>
          <Checklist id={id} wf={wf} onDone={refresh} />
        </div>
      </div>

      {wf.can.requestCorrection && <CorrectionForm id={id} onDone={refresh} />}
      {wf.corrections.length > 0 && (
        <>
          <h3>{t('wf.correction')}</h3>
          <ul>
            {wf.corrections.map((c) => (
              <li key={c.id}>
                {c.message} <span className="muted small">({c.items.map((i) => tk(`section.${i}`) !== `section.${i}` ? tk(`section.${i}`) : tk(`doc.${i}`)).join(', ')} · {date(c.at, true)})</span>{' '}
                {c.resolvedAt ? <span className="badge badge-passed">{t('common.done')}</span> : <span className="badge badge-pending">{t('common.pending')}</span>}
              </li>
            ))}
          </ul>
        </>
      )}

      <h3>{t('wf.inspection')}</h3>
      {wf.inspections.length === 0 && <p className="muted">{t('insp.empty')}</p>}
      <ul>
        {wf.inspections.map((i) => (
          <li key={i.id}>
            <span className={`badge badge-${i.status.toLowerCase()}`}>{tk(`inspection.${i.status}`)}</span> {i.scheduledFor ? `${date(i.scheduledFor, true)} · ${i.location}` : date(i.requestedAt, true)}{' '}
            <span className="small muted">({t('vehicle.chassis')}: {i.chassisNo})</span>
            {i.certificateNo && <div className="small">{t('wf.certificate', { no: i.certificateNo, date: date(i.validUntil) })}</div>}
            {i.status === 'PASSED' && !i.countersigned && <div className="small muted">{t('wf.awaitingCountersign')}</div>}
          </li>
        ))}
      </ul>

      <h3>{t('wf.invoice')}</h3>
      {wf.invoice ? <InvoiceView invoice={wf.invoice} /> : <p className="muted">—</p>}

      {(wf.status === 'UNDER_VERIFICATION' && wf.verifiedBy?.isMe) || (wf.status === 'UNDER_VERIFICATION' && !wf.can.decide && wf.gates.some((g) => g.gate === 'SEPARATION_OF_DUTIES' && !g.ok)) ? (
        <Notice kind="warning">{t('wf.verifiedByMe')}</Notice>
      ) : null}
      {flash && (
        <Notice kind="success">
          <span data-testid="decision-flash">{flash}</span>
        </Notice>
      )}
      {wf.can.decide && <DecisionForms id={id} wf={wf} onDone={refresh} onFlash={setFlash} />}

      {(wf.decisions.length > 0 || wf.appeals.length > 0) && (
        <>
          <h3>{t('wf.history')}</h3>
          <ol className="timeline">
            {wf.decisions.map((d, i) => (
              <li key={`d${i}`}>
                <span className={`badge badge-${d.decision.toLowerCase()}`}>{tk(`decision.${d.decision}`)}</span>{' '}
                <span className="muted small">
                  {d.by} · {date(d.at, true)}
                </span>
                {d.reasons.length > 0 && <div className="small">{d.reasons.map((r) => tk(`reason.${r}`)).join(', ')}</div>}
                {d.reasonText && <p>{d.reasonText}</p>}
              </li>
            ))}
            {wf.appeals.map((a) => (
              <li key={a.id}>
                {t('nav.appeals')}: <span className={`badge badge-${a.status.toLowerCase()}`}>{tk(`appealstatus.${a.status}`)}</span>{' '}
                <span className="muted small">{date(a.filedAt, true)}</span>
                <p>{a.grounds}</p>
                {a.decisionNote && <p className="small">{a.decisionNote}</p>}
              </li>
            ))}
          </ol>
          {wf.appealDeadline && !wf.rejectionFinal && <p className="small">{t('wf.appealDeadline', { date: date(wf.appealDeadline) })}</p>}
          {wf.rejectionFinal && <p className="small">{t('wf.rejectionFinal')}</p>}
        </>
      )}

      {wf.registration && (
        <>
          <h3>{t('wf.registration')}</h3>
          <DefinitionList
            rows={[
              [t('reg.plate'), wf.registration.plateTextBn],
              [t('reg.systemId'), wf.registration.plateSystemId],
              [t('reg.validUntil'), date(wf.registration.validUntil)],
            ]}
          />
        </>
      )}
    </section>
  );
}

function StartVerification({ id, onDone }: { id: string; onDone: () => Promise<void> }) {
  const { t } = useI18n();
  const a = useAction();
  return (
    <div className="row">
      <button type="button" className="btn" disabled={a.busy} onClick={() => a.run(async () => { await api(`/admin/applications/${id}/start-verification`, { method: 'POST' }); await onDone(); })}>
        {t('wf.startVerification')}
      </button>
      <ErrorAlert error={a.error} />
    </div>
  );
}

function Checklist({ id, wf, onDone }: { id: string; wf: Workflow; onDone: () => Promise<void> }) {
  const { t, date } = useI18n();
  const a = useAction();
  const lastBy = (item: string) => [...wf.checks].reverse().find((c) => c.item === item);
  async function record(item: string, result: 'PASS' | 'FAIL') {
    await a.run(async () => {
      await api(`/admin/applications/${id}/checks`, { method: 'POST', json: { item, result } });
      await onDone();
    });
  }
  return (
    <div>
      {VERIFICATION_ITEMS.map((item) => {
        const state = wf.detail.checklist[item];
        const last = lastBy(item);
        return (
          <div className="checkrow" key={item} data-testid={`check-${item}`}>
            <div>
              <span className="mark" aria-hidden="true">{state === 'PASS' ? '✓ ' : state === 'FAIL' ? '✗ ' : '○ '}</span>
              {t(`check.${item}` as never)}
              {last && (
                <div className="small muted">
                  {last.by} · {date(last.at, true)}
                </div>
              )}
            </div>
            {wf.can.check && (
              <div className="actions">
                <button type="button" className="btn btn-secondary" disabled={a.busy || state === 'PASS'} onClick={() => record(item, 'PASS')} aria-label={`${t(`check.${item}` as never)}: ${t('common.pass')}`}>
                  {t('common.pass')}
                </button>
                <button type="button" className="btn btn-ghost" disabled={a.busy || state === 'FAIL'} onClick={() => record(item, 'FAIL')} aria-label={`${t(`check.${item}` as never)}: ${t('common.fail')}`}>
                  {t('common.fail')}
                </button>
              </div>
            )}
          </div>
        );
      })}
      <ErrorAlert error={a.error} />
    </div>
  );
}

function CorrectionForm({ id, onDone }: { id: string; onDone: () => Promise<void> }) {
  const { t, tk } = useI18n();
  const a = useAction();
  const [items, setItems] = useState<string[]>([]);
  const [message, setMessage] = useState('');
  const toggle = (k: string) => setItems((x) => (x.includes(k) ? x.filter((y) => y !== k) : [...x, k]));
  async function submit(e: FormEvent) {
    e.preventDefault();
    await a.run(async () => {
      await api(`/admin/applications/${id}/request-correction`, { method: 'POST', json: { items, message } });
      await onDone();
    });
  }
  return (
    <details>
      <summary>
        <strong>{t('wf.correction')}</strong>
      </summary>
      <form onSubmit={submit}>
        <fieldset>
          <legend>{t('wf.correctionItems')}</legend>
          <div className="pillset">
            {[...CORRECTION_SECTIONS, ...DOCUMENT_TYPE_LIST].map((k) => (
              <label key={k}>
                <input type="checkbox" checked={items.includes(k)} onChange={() => toggle(k)} />
                {CORRECTION_SECTIONS.includes(k as never) ? tk(`section.${k}`) : tk(`doc.${k}`)}
              </label>
            ))}
          </div>
          {a.fields.items && <p className="field-error">{tk(`field.${a.fields.items}`)}</p>}
        </fieldset>
        <Field label={t('wf.correctionMessage')} error={a.fields.message} required>
          {(p) => <textarea {...p} value={message} onChange={(e) => setMessage(e.target.value)} />}
        </Field>
        <ErrorAlert error={a.error} />
        <button className="btn btn-secondary" disabled={a.busy}>
          {t('wf.correctionSend')}
        </button>
      </form>
    </details>
  );
}

function DecisionForms({ id, wf, onDone, onFlash }: { id: string; wf: Workflow; onDone: () => Promise<void>; onFlash: (msg: string) => void }) {
  const { t, tk, date } = useI18n();
  const approve = useAction();
  const reject = useAction();
  const [note, setNote] = useState('');
  const [totpA, setTotpA] = useState('');
  const [reasons, setReasons] = useState<string[]>([]);
  const [text, setText] = useState('');
  const [totpR, setTotpR] = useState('');
  async function doApprove(e: FormEvent) {
    e.preventDefault();
    const ok = await approve.run(async () => {
      await api(`/admin/applications/${id}/approve`, { method: 'POST', json: { note: note || undefined, totp: totpA } });
      return true;
    });
    if (ok) {
      onFlash(t('wf.approved'));
      await onDone();
    }
  }
  async function doReject(e: FormEvent) {
    e.preventDefault();
    if (!window.confirm(t('wf.reject') + '?')) return;
    const r = await reject.run(() => api<{ appealDeadline: string }>(`/admin/applications/${id}/reject`, { method: 'POST', json: { reasons, reasonText: text, totp: totpR } }));
    if (r) {
      onFlash(t('wf.rejected', { date: date(r.appealDeadline) }));
      await onDone();
    }
  }
  return (
    <div className="grid2">
      <form className="card" onSubmit={doApprove} aria-labelledby="approve-h">
        <h3 id="approve-h">{t('wf.approve')}</h3>
        {!wf.can.approve && <Notice kind="warning">{t('wf.cannotApprove')}</Notice>}
        <Field label={t('wf.approveNote')} error={approve.fields.note}>
          {(p) => <textarea {...p} value={note} onChange={(e) => setNote(e.target.value)} />}
        </Field>
        <TotpField value={totpA} onChange={setTotpA} error={approve.fields.totp} />
        <ErrorAlert error={approve.error} />
        <button className="btn" disabled={approve.busy || !wf.can.approve}>
          {t('wf.approve')}
        </button>
      </form>
      <form className="card" onSubmit={doReject} aria-labelledby="reject-h">
        <h3 id="reject-h">{t('wf.reject')}</h3>
        <fieldset>
          <legend>{t('wf.rejectReasons')}</legend>
          <div className="pillset">
            {REJECTION_REASONS.map((r) => (
              <label key={r}>
                <input type="checkbox" checked={reasons.includes(r)} onChange={() => setReasons((x) => (x.includes(r) ? x.filter((y) => y !== r) : [...x, r]))} />
                {tk(`reason.${r}`)}
              </label>
            ))}
          </div>
          {reject.fields.reasons && <p className="field-error">{tk(`field.${reject.fields.reasons}`)}</p>}
        </fieldset>
        <Field label={t('wf.rejectText')} error={reject.fields.reasonText} required>
          {(p) => <textarea {...p} value={text} onChange={(e) => setText(e.target.value)} />}
        </Field>
        <TotpField value={totpR} onChange={setTotpR} error={reject.fields.totp} />
        <ErrorAlert error={reject.error} />
        <button className="btn btn-danger" disabled={reject.busy}>
          {t('wf.reject')}
        </button>
      </form>
    </div>
  );
}

