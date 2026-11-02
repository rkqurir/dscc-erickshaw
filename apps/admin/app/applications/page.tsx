'use client';

import { APPLICATION_STATUSES } from '@dscc/domain';
import { ErrorAlert, Field, Notice, Spinner, StatusBadge, ZoneChip, api, useI18n } from '@dscc/web-ui';
import Link from 'next/link';
import { FormEvent, useCallback, useEffect, useState } from 'react';
import { useRequireStaff } from '../../components/session';

interface Row {
  id: string;
  applicationNumber: string;
  status: string;
  submittedAt: string;
  decisionDueDate: string | null;
  workingDaysElapsed: number;
  sla: 'ON_TRACK' | 'AT_RISK' | 'OVERDUE' | null;
  owner: { nameBn: string; nidMasked: string; verificationStatus: string } | null;
  zone: { id: string; code: string; nameBn: string; nameEn: string; uiColour: string } | null;
  ward: { number: number; nameBn: string; nameEn: string } | null;
  seatType: string | null;
}
interface Summary {
  byStatus: Record<string, number>;
  byZone: { code: string; nameBn: string; nameEn: string; uiColour: string; count: number }[];
  total: number;
}
interface Zone {
  id: string;
  code: string;
  nameBn: string;
  nameEn: string;
}

const STATUSES = APPLICATION_STATUSES.filter((s) => s !== 'DRAFT');

export default function Queue() {
  const me = useRequireStaff('application.read');
  const { t, tk, num, date, lang } = useI18n();
  const [rows, setRows] = useState<Row[] | null>(null);
  const [cursor, setCursor] = useState<string | null>(null);
  const [summary, setSummary] = useState<Summary | null>(null);
  const [zones, setZones] = useState<Zone[]>([]);
  const [filters, setFilters] = useState({ status: '', zoneId: '', q: '' });
  const [applied, setApplied] = useState(filters);
  const [error, setError] = useState<unknown>(null);
  const [loadingMore, setLoadingMore] = useState(false);

  const query = useCallback(
    (c?: string | null) => {
      const p = new URLSearchParams({ limit: '25' });
      if (applied.status) p.set('status', applied.status);
      if (applied.zoneId) p.set('zoneId', applied.zoneId);
      if (applied.q.trim()) p.set('q', applied.q.trim());
      if (c) p.set('cursor', c);
      return `/admin/applications?${p.toString()}`;
    },
    [applied],
  );

  useEffect(() => {
    if (!me) return;
    setRows(null);
    setError(null);
    void Promise.all([api<{ items: Row[]; nextCursor: string | null }>(query()), api<Summary>('/admin/applications/summary'), api<Zone[]>('/catalog/zones')])
      .then(([list, s, z]) => {
        setRows(list.items);
        setCursor(list.nextCursor);
        setSummary(s);
        setZones(z);
      })
      .catch(setError);
  }, [me, query]);

  if (!me) return <Spinner />;

  async function more() {
    if (!cursor) return;
    setLoadingMore(true);
    try {
      const r = await api<{ items: Row[]; nextCursor: string | null }>(query(cursor));
      setRows((prev) => [...(prev ?? []), ...r.items]);
      setCursor(r.nextCursor);
    } catch (e) {
      setError(e);
    } finally {
      setLoadingMore(false);
    }
  }

  function apply(e: FormEvent) {
    e.preventDefault();
    setApplied({ ...filters });
  }

  return (
    <>
      <h1>{t('admin.queue.title')}</h1>
      <Notice>{t('admin.queue.readOnly')}</Notice>
      {summary && (
        <div className="stats" data-testid="summary">
          <div className="stat">
            <div className="muted small">{t('admin.summary.total')}</div>
            <div className="num">{num(summary.total)}</div>
          </div>
          {STATUSES.filter((s) => summary.byStatus[s]).map((s) => (
            <div className="stat" key={s}>
              <div className="muted small">{tk(`status.${s}`)}</div>
              <div className="num">{num(summary.byStatus[s])}</div>
            </div>
          ))}
          {summary.byZone.map((z) => (
            <div className="stat" key={z.code}>
              <div className="muted small">
                <ZoneChip zone={z} />
              </div>
              <div className="num">{num(z.count)}</div>
            </div>
          ))}
        </div>
      )}
      <form className="card grid2" onSubmit={apply} style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', alignItems: 'end' }}>
        <Field label={t('admin.filter.status')} required={false}>
          {(p) => (
            <select {...p} value={filters.status} onChange={(e) => setFilters({ ...filters, status: e.target.value })}>
              <option value="">{t('common.all')}</option>
              {STATUSES.map((s) => (
                <option key={s} value={s}>
                  {tk(`status.${s}`)}
                </option>
              ))}
            </select>
          )}
        </Field>
        <Field label={t('admin.filter.zone')} required={false}>
          {(p) => (
            <select {...p} value={filters.zoneId} onChange={(e) => setFilters({ ...filters, zoneId: e.target.value })}>
              <option value="">{t('common.all')}</option>
              {zones.map((z) => (
                <option key={z.id} value={z.id}>
                  {z.code} · {lang === 'bn' ? z.nameBn : z.nameEn}
                </option>
              ))}
            </select>
          )}
        </Field>
        <Field label={t('admin.filter.search')} required={false}>
          {(p) => <input {...p} type="text" placeholder="DSCC-2026-000125" value={filters.q} onChange={(e) => setFilters({ ...filters, q: e.target.value })} />}
        </Field>
        <div className="field">
          <button className="btn" type="submit">
            {t('common.search')}
          </button>
        </div>
      </form>
      <ErrorAlert error={error} />
      {!rows ? (
        <Spinner />
      ) : rows.length === 0 ? (
        <p className="muted">{t('admin.empty')}</p>
      ) : (
        <div className="table-wrap card" style={{ padding: 0 }}>
          <table className="responsive">
            <thead>
              <tr>
                <th>{t('dash.col.number')}</th>
                <th>{t('admin.col.owner')}</th>
                <th>{t('admin.col.nid')}</th>
                <th>{t('dash.col.zone')}</th>
                <th>{t('admin.col.ward')}</th>
                <th>{t('dash.col.status')}</th>
                <th>{t('admin.col.submitted')}</th>
                <th>{t('admin.col.sla')}</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id}>
                  <td data-label={t('dash.col.number')}>
                    <Link href={`/applications/${r.id}`}>{r.applicationNumber}</Link>
                  </td>
                  <td data-label={t('admin.col.owner')}>{r.owner?.nameBn ?? '—'}</td>
                  <td data-label={t('admin.col.nid')}>{r.owner?.nidMasked ?? '—'}</td>
                  <td data-label={t('dash.col.zone')}>
                    <ZoneChip zone={r.zone} />
                  </td>
                  <td data-label={t('admin.col.ward')}>{r.ward ? (lang === 'bn' ? r.ward.nameBn : r.ward.nameEn) : '—'}</td>
                  <td data-label={t('dash.col.status')}>
                    <StatusBadge status={r.status} />
                  </td>
                  <td data-label={t('admin.col.submitted')}>{date(r.submittedAt)}</td>
                  <td data-label={t('admin.col.sla')}>
                    {num(r.workingDaysElapsed)}
                    {r.sla && <span className={`badge badge-${r.sla.toLowerCase()}`}> {tk(`sla.${r.sla}`)}</span>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {cursor && (
        <button className="btn btn-secondary" type="button" onClick={more} disabled={loadingMore}>
          {t('common.loadMore')}
        </button>
      )}
    </>
  );
}
