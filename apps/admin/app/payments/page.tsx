'use client';

import { ErrorAlert, Field, Notice, Spinner, api, useAction, useI18n } from '@dscc/web-ui';
import Link from 'next/link';
import { FormEvent, useCallback, useEffect, useState } from 'react';
import { InvoiceView } from '../../components/workflow-panel';
import { useRequireStaff } from '../../components/session';

interface InvoiceRow {
  id: string;
  invoiceNo: string;
  status: string;
  totalBdt: number;
  lines: { service: string; amountBdt: number; legalRef: string }[];
  payments: { method: string; reference: string; amountBdt: number; status: string; receiptNo: string | null; at: string }[];
  createdAt: string;
  application: { id: string; applicationNumber: string; status: string } | null;
  owner: { nameBn: string; nidMasked: string } | null;
}
interface Fee {
  id: string;
  service: string;
  seatType: string | null;
  amountBdt: number;
  effectiveFrom: string;
  effectiveTo: string | null;
  legalRef: string;
}

const FILTERS = ['UNPAID', 'PAID', 'CANCELLED'] as const;

export default function Payments() {
  const me = useRequireStaff('payment.read');
  const { t, tk, num, date } = useI18n();
  const [status, setStatus] = useState<string>('UNPAID');
  const [rows, setRows] = useState<InvoiceRow[] | null>(null);
  const [fees, setFees] = useState<Fee[] | null>(null);
  const [error, setError] = useState<unknown>(null);
  const load = useCallback(async () => {
    try {
      setRows(await api<InvoiceRow[]>(`/admin/invoices?status=${status}`));
    } catch (e) {
      setError(e);
    }
  }, [status]);
  useEffect(() => {
    if (me) void load();
  }, [me, load]);
  useEffect(() => {
    if (me?.permissions.includes('fee.read')) void api<Fee[]>('/admin/fee-schedules').then(setFees).catch(setError);
  }, [me]);
  if (!me) return <Spinner />;

  return (
    <>
      <h1>{t('pay.title')}</h1>
      <Notice>{t('pay.note')}</Notice>
      {fees && (
        <details className="card">
          <summary>
            <strong>{t('pay.schedule')}</strong>
          </summary>
          <div className="table-wrap">
            <table className="responsive">
              <tbody>
                {fees.map((f) => (
                  <tr key={f.id}>
                    <td data-label="">{tk(`fee.${f.service}`)}</td>
                    <td data-label="">{f.seatType ? tk(`seat.${f.seatType}`) : t('pay.allTypes')}</td>
                    <td data-label="">{t('common.taka', { amount: num(f.amountBdt) })}</td>
                    <td data-label="" className="small muted">
                      {t('pay.effective', { date: date(f.effectiveFrom) })} · {f.legalRef}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </details>
      )}
      <div className="row" role="group" aria-label={t('admin.filter.status')}>
        {FILTERS.map((f) => (
          <button key={f} type="button" className={f === status ? 'btn' : 'btn btn-secondary'} aria-pressed={f === status} onClick={() => setStatus(f)}>
            {tk(`invoice.${f}`)}
          </button>
        ))}
      </div>
      <ErrorAlert error={error} />
      {!rows ? (
        <Spinner />
      ) : rows.length === 0 ? (
        <p className="muted">{t('pay.empty')}</p>
      ) : (
        rows.map((r) => (
          <article className="card" key={r.id} data-testid="invoice">
            <h2 style={{ marginTop: 0 }}>
              {r.application && me.permissions.includes('application.read') ? <Link href={`/applications/${r.application.id}`}>{r.application.applicationNumber}</Link> : r.application?.applicationNumber}
              {r.owner && (
                <span className="muted small">
                  {' '}
                  · {r.owner.nameBn} · NID {r.owner.nidMasked}
                </span>
              )}
            </h2>
            <InvoiceView invoice={r} />
            {r.status === 'UNPAID' && me.permissions.includes('payment.record') && <ChallanForm invoice={r} onDone={load} />}
          </article>
        ))
      )}
    </>
  );
}

function ChallanForm({ invoice, onDone }: { invoice: InvoiceRow; onDone: () => Promise<void> }) {
  const { t } = useI18n();
  const a = useAction();
  const [f, setF] = useState({ challanNo: '', amountBdt: String(invoice.totalBdt), paidOn: '', bankName: '' });
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) => setF((x) => ({ ...x, [k]: e.target.value }));
  async function submit(e: FormEvent) {
    e.preventDefault();
    await a.run(
      async () => {
        const r = await api<{ receiptNo: string }>(`/admin/invoices/${invoice.id}/counter-payment`, { method: 'POST', json: f });
        await onDone();
        return r;
      },
      (r) => t('pay.recorded', { no: r.receiptNo }),
    );
  }
  return (
    <details>
      <summary>
        <strong>{t('pay.recordChallan')}</strong>
      </summary>
      <form onSubmit={submit}>
        <div className="grid2">
          <Field label={t('pay.challanNo')} error={a.fields.challanNo} required>
            {(p) => <input {...p} type="text" value={f.challanNo} onChange={set('challanNo')} />}
          </Field>
          <Field label={t('pay.amount')} error={a.fields.amountBdt} required>
            {(p) => <input {...p} type="number" inputMode="numeric" value={f.amountBdt} onChange={set('amountBdt')} />}
          </Field>
          <Field label={t('pay.paidOn')} error={a.fields.paidOn} required>
            {(p) => <input {...p} type="date" value={f.paidOn} onChange={set('paidOn')} />}
          </Field>
          <Field label={t('pay.bank')} error={a.fields.bankName} required>
            {(p) => <input {...p} type="text" value={f.bankName} onChange={set('bankName')} />}
          </Field>
        </div>
        <ErrorAlert error={a.error} />
        {a.done && <Notice kind="success">{a.done}</Notice>}
        <button className="btn" disabled={a.busy}>
          {t('common.save')}
        </button>
      </form>
    </details>
  );
}
