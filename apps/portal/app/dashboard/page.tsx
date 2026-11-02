'use client';

import { ErrorAlert, Field, Spinner, StatusBadge, ZoneChip, api, useI18n } from '@dscc/web-ui';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { FormEvent, useCallback, useEffect, useState } from 'react';
import { useRequireCitizen } from '../../components/session';

interface Quota {
  limit: number;
  registered: number;
  pending: number;
  otherCities: number;
  used: number;
  remaining: number;
}
interface AppRow {
  id: string;
  applicationNumber: string | null;
  status: string;
  createdAt: string;
  submittedAt: string | null;
  decisionDueDate: string | null;
  zone: { code: string; nameBn: string; nameEn: string; uiColour: string } | null;
}
interface External {
  id: string;
  cityName: string;
  registrationNo: string;
  status: string;
  declaredAt: string;
}

export default function Dashboard() {
  const me = useRequireCitizen();
  const { t, num, date, tk } = useI18n();
  const router = useRouter();
  const [quota, setQuota] = useState<Quota | null>(null);
  const [apps, setApps] = useState<AppRow[] | null>(null);
  const [external, setExternal] = useState<External[]>([]);
  const [error, setError] = useState<unknown>(null);
  const [creating, setCreating] = useState(false);
  const [ext, setExt] = useState({ cityName: '', registrationNo: '' });
  const [extErrors, setExtErrors] = useState<Record<string, string>>({});
  const [extError, setExtError] = useState<unknown>(null);

  const load = useCallback(async () => {
    try {
      const list = await api<AppRow[]>('/applications');
      setApps(list);
      if (me?.owner) {
        const [q, x] = await Promise.all([api<Quota>('/owners/me/vehicle-quota'), api<External[]>('/owners/me/external-registrations')]);
        setQuota(q);
        setExternal(x);
      }
    } catch (e) {
      setError(e);
    }
  }, [me?.owner]);

  useEffect(() => {
    if (me) void load();
  }, [me, load]);

  if (!me) return <Spinner />;

  async function newApplication() {
    setCreating(true);
    setError(null);
    try {
      const d = await api<{ id: string }>('/applications', { method: 'POST' });
      router.push(`/applications/${d.id}`);
    } catch (e) {
      setError(e);
      setCreating(false);
    }
  }

  async function addExternal(e: FormEvent) {
    e.preventDefault();
    setExtError(null);
    setExtErrors({});
    try {
      await api('/owners/me/external-registrations', { method: 'POST', json: ext });
      setExt({ cityName: '', registrationNo: '' });
      await load();
    } catch (err) {
      setExtError(err);
      if (err && typeof err === 'object' && 'fields' in err) setExtErrors((err as { fields: Record<string, string> }).fields);
    }
  }

  const limitReached = !!quota && quota.remaining <= 0;
  const pct = (n: number) => `${(n / (quota?.limit || 5)) * 100}%`;

  return (
    <>
      <h1>{t('dash.title')}</h1>
      <p className="muted">{t('dash.loggedInAs', { phone: num(me.phone.replace('+88', '')) })}</p>
      <ErrorAlert error={error} />

      {!me.owner ? (
        <div className="card">
          <h2>{t('dash.ownerMissingTitle')}</h2>
          <p>{t('dash.ownerMissingBody')}</p>
          <Link className="btn" href="/owner/register">
            {t('dash.ownerRegister')}
          </Link>
        </div>
      ) : (
        <div className="card">
          <p>
            {t('dash.owner', { name: me.owner.nameBn, nid: me.owner.nidMasked })} ·{' '}
            <span className="badge">{tk(`verification.${me.owner.verificationStatus}`)}</span>
          </p>
          <h2>{t('dash.quotaTitle')}</h2>
          {quota ? (
            <>
              <div className="quota-bar" aria-hidden="true">
                <span className="quota-registered" style={{ width: pct(quota.registered) }} />
                <span className="quota-pending" style={{ width: pct(quota.pending) }} />
                <span className="quota-other" style={{ width: pct(quota.otherCities) }} />
              </div>
              <p data-testid="quota-line">
                {t('dash.quotaLine', { registered: quota.registered, pending: quota.pending, other: quota.otherCities, remaining: quota.remaining })}
              </p>
              {limitReached && (
                <div className="alert alert-warning" role="alert" data-testid="limit-reached">
                  {t('dash.limitReached')}
                </div>
              )}
              <button className="btn" type="button" onClick={newApplication} disabled={creating || limitReached} aria-disabled={limitReached}>
                {t('dash.newApplication')}
              </button>
            </>
          ) : (
            <Spinner />
          )}
        </div>
      )}

      <div className="card">
        <h2>{t('dash.applications')}</h2>
        {!apps ? (
          <Spinner />
        ) : apps.length === 0 ? (
          <p className="muted">{t('dash.noApplications')}</p>
        ) : (
          <div className="table-wrap">
            <table className="responsive">
              <thead>
                <tr>
                  <th>{t('dash.col.number')}</th>
                  <th>{t('dash.col.status')}</th>
                  <th>{t('dash.col.zone')}</th>
                  <th>{t('dash.col.date')}</th>
                  <th>{t('dash.col.due')}</th>
                </tr>
              </thead>
              <tbody>
                {apps.map((a) => (
                  <tr key={a.id}>
                    <td data-label={t('dash.col.number')}>
                      <Link href={`/applications/${a.id}`}>{a.applicationNumber ?? t('dash.draftNoNumber')}</Link>
                    </td>
                    <td data-label={t('dash.col.status')}>
                      <StatusBadge status={a.status} />
                    </td>
                    <td data-label={t('dash.col.zone')}>
                      <ZoneChip zone={a.zone} />
                    </td>
                    <td data-label={t('dash.col.date')}>{date(a.submittedAt ?? a.createdAt)}</td>
                    <td data-label={t('dash.col.due')}>{a.decisionDueDate ? date(a.decisionDueDate) : '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {me.owner && (
        <div className="card">
          <h2>{t('dash.externalTitle')}</h2>
          <p className="muted small">{t('dash.externalHelp')}</p>
          {external.length === 0 ? (
            <p className="muted">{t('dash.externalNone')}</p>
          ) : (
            <ul>
              {external.map((x) => (
                <li key={x.id}>
                  {x.cityName} — {x.registrationNo} ({date(x.declaredAt)})
                </li>
              ))}
            </ul>
          )}
          <ErrorAlert error={extError} />
          <form onSubmit={addExternal} className="grid2" noValidate>
            <Field label={t('dash.externalCity')} error={extErrors.cityName} required>
              {(p) => <input {...p} type="text" value={ext.cityName} onChange={(e) => setExt({ ...ext, cityName: e.target.value })} />}
            </Field>
            <Field label={t('dash.externalRegNo')} error={extErrors.registrationNo} required>
              {(p) => <input {...p} type="text" value={ext.registrationNo} onChange={(e) => setExt({ ...ext, registrationNo: e.target.value })} />}
            </Field>
            <div>
              <button className="btn btn-secondary" type="submit" disabled={!ext.cityName.trim() || !ext.registrationNo.trim() || limitReached}>
                {t('dash.externalAdd')}
              </button>
            </div>
          </form>
        </div>
      )}
    </>
  );
}
