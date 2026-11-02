'use client';

import { ReactNode, useId } from 'react';
import { ApiError } from './api';
import { useI18n } from './i18n';

export function ErrorAlert({ error }: { error: unknown }) {
  const { lang, t } = useI18n();
  if (!error) return null;
  const msg = error instanceof ApiError ? error.localized(lang) : t('common.retry');
  return (
    <div className="alert alert-error" role="alert">
      {msg}
    </div>
  );
}

export function Notice({ kind = 'info', children }: { kind?: 'info' | 'success' | 'warning'; children: ReactNode }) {
  return (
    <div className={`alert alert-${kind}`} role={kind === 'success' ? 'status' : undefined}>
      {children}
    </div>
  );
}

/** Labelled field with an accessible error message. `error` is a field error code from the API or client validation. */
export function Field({
  label,
  hint,
  error,
  required,
  children,
}: {
  label: string;
  hint?: string;
  error?: string;
  required?: boolean;
  children: (props: { id: string; 'aria-invalid': boolean; 'aria-describedby'?: string; required?: boolean }) => ReactNode;
}) {
  const id = useId();
  const { tk, t } = useI18n();
  const hintId = hint ? `${id}-hint` : undefined;
  const errId = error ? `${id}-err` : undefined;
  return (
    <div className={`field${error ? ' field-invalid' : ''}`}>
      <label htmlFor={id}>
        {label}
        {required ? <span className="req" aria-hidden="true"> *</span> : <span className="opt"> ({t('common.optional')})</span>}
      </label>
      {children({ id, 'aria-invalid': !!error, 'aria-describedby': [hintId, errId].filter(Boolean).join(' ') || undefined, required })}
      {hint && (
        <p className="hint" id={hintId}>
          {hint}
        </p>
      )}
      {error && (
        <p className="field-error" id={errId}>
          {tk(`field.${error}`)}
        </p>
      )}
    </div>
  );
}

export function StatusBadge({ status }: { status: string }) {
  const { tk } = useI18n();
  return <span className={`badge badge-${status.toLowerCase()}`}>{tk(`status.${status}`)}</span>;
}

export function ZoneChip({ zone }: { zone: { code: string; nameBn: string; nameEn: string; uiColour: string } | null }) {
  const { lang } = useI18n();
  if (!zone) return <span>—</span>;
  return (
    <span className="zone-chip">
      <span className="swatch" style={{ background: zone.uiColour }} aria-hidden="true" />
      {zone.code} · {lang === 'bn' ? zone.nameBn : zone.nameEn}
    </span>
  );
}

export function Spinner() {
  const { t } = useI18n();
  return (
    <p className="loading" role="status">
      {t('common.loading')}
    </p>
  );
}

export function DefinitionList({ rows }: { rows: [string, ReactNode][] }) {
  return (
    <dl className="deflist">
      {rows.map(([k, v]) => (
        <div key={k}>
          <dt>{k}</dt>
          <dd>{v === null || v === undefined || v === '' ? '—' : v}</dd>
        </div>
      ))}
    </dl>
  );
}

/** Schedule 3 plate layout: city name, area code-number, "ই-রিক্সা"; white letters on the zone's plate colour. */
export function PlateView({ textBn, systemId, background }: { textBn: string; systemId: string; background: string }) {
  const i = textBn.indexOf('-');
  const city = i > 0 ? textBn.slice(0, i) : textBn;
  const rest = i > 0 ? textBn.slice(i + 1) : '';
  return (
    <div>
      <div className="plate" style={{ background }} role="img" aria-label={`${textBn} (${systemId})`} data-testid="plate">
        <span className="plate-city">{city}</span>
        <span className="plate-num">{rest}</span>
        <span className="plate-type">ই-রিক্সা</span>
      </div>
      <p className="small muted" lang="en">
        {systemId}
      </p>
    </div>
  );
}

export interface InvoiceData {
  invoiceNo: string;
  status: string;
  totalBdt: number;
  lines: { service: string; amountBdt: number; legalRef: string }[];
  payments: { method: string; reference: string; amountBdt: number; status: string; receiptNo: string | null; at: string }[];
}

/** Invoice with its Schedule 2 lines and successful receipts. */
export function InvoiceSummary({ invoice }: { invoice: InvoiceData }) {
  const { t, tk, num, date } = useI18n();
  return (
    <>
      <p>
        {t('invoice.number', { no: invoice.invoiceNo })} <span className={`badge badge-${invoice.status.toLowerCase()}`}>{tk(`invoice.${invoice.status}`)}</span>
      </p>
      <DefinitionList
        rows={[
          ...invoice.lines.map((l) => [tk(`fee.${l.service}`), t('common.taka', { amount: num(l.amountBdt) })] as [string, string]),
          [t('invoice.total'), <strong key="t">{t('common.taka', { amount: num(invoice.totalBdt) })}</strong>],
        ]}
      />
      {invoice.payments
        .filter((p) => p.status === 'SUCCEEDED')
        .map((p) => (
          <p key={p.reference} className="small muted">
            {t('invoice.receipt', { no: p.receiptNo ?? '' })} · {tk(`method.${p.method}`)} · {p.reference} · {date(p.at, true)}
          </p>
        ))}
    </>
  );
}

