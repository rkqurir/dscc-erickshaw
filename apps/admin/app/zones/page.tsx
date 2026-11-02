'use client';

import { ApiError, ErrorAlert, Field, Notice, Spinner, api, useI18n } from '@dscc/web-ui';
import { FormEvent, useCallback, useEffect, useState } from 'react';
import { useRequireStaff } from '../../components/session';

interface Zone {
  id: string;
  code: string;
  nameBn: string;
  nameEn: string;
  uiColour: string;
  plateBackgroundColour: string;
  plateAreaCodeBn: string;
  vehicleQuota: number | null;
  approvalStatus: string;
  version: number;
  wardCount: number;
  plateContrast: number;
  plateContrastOk: boolean;
  examples: { systemId: string; plateBn: string };
}
interface Version {
  version: number;
  changeNote: string;
  changedBy: string | null;
  changedAt: string;
  snapshot: Record<string, unknown>;
}

function Plate({ zone }: { zone: Pick<Zone, 'plateBackgroundColour' | 'examples'> }) {
  const [city, ...rest] = zone.examples.plateBn.split('-');
  return (
    <div className="plate" role="img" style={{ background: zone.plateBackgroundColour }} aria-label={zone.examples.plateBn}>
      <span className="plate-city">{city}</span>
      <span className="plate-num">{rest.join('-')}</span>
      <span className="plate-type">ই-রিক্সা</span>
    </div>
  );
}

function ZoneCard({ zone, canManage, onSaved }: { zone: Zone; canManage: boolean; onSaved: (z: Zone) => void }) {
  const { t, tk, num, date, lang } = useI18n();
  const [editing, setEditing] = useState(false);
  const [form, setForm] = useState({
    nameBn: zone.nameBn,
    nameEn: zone.nameEn,
    uiColour: zone.uiColour,
    plateBackgroundColour: zone.plateBackgroundColour,
    plateAreaCodeBn: zone.plateAreaCodeBn,
    vehicleQuota: zone.vehicleQuota === null ? '' : String(zone.vehicleQuota),
    approvalStatus: zone.approvalStatus,
    changeNote: '',
  });
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [error, setError] = useState<unknown>(null);
  const [saved, setSaved] = useState(false);
  const [busy, setBusy] = useState(false);
  const [history, setHistory] = useState<Version[] | null>(null);

  async function save(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    setErrors({});
    setSaved(false);
    try {
      const z = await api<Zone>(`/admin/zones/${zone.id}`, {
        method: 'PATCH',
        json: { ...form, vehicleQuota: form.vehicleQuota === '' ? null : Number(form.vehicleQuota), version: zone.version },
      });
      onSaved(z);
      setEditing(false);
      setSaved(true);
      setForm((f) => ({ ...f, changeNote: '' }));
      if (history) setHistory(await api<Version[]>(`/admin/zones/${zone.id}/versions`));
    } catch (err) {
      setError(err);
      if (err instanceof ApiError) setErrors(err.fields);
    } finally {
      setBusy(false);
    }
  }

  async function toggleHistory() {
    if (history) setHistory(null);
    else setHistory(await api<Version[]>(`/admin/zones/${zone.id}/versions`).catch((e) => (setError(e), null)));
  }

  const set = (k: keyof typeof form) => (e: { target: { value: string } }) => setForm({ ...form, [k]: e.target.value });

  return (
    <section className="card" data-testid={`zone-${zone.code}`} style={{ borderLeft: `6px solid ${zone.uiColour}` }}>
      <div className="row spread">
        <h2 style={{ margin: 0 }}>
          {zone.code} · {lang === 'bn' ? zone.nameBn : zone.nameEn}
        </h2>
        <span className="badge">{tk(`approval.${zone.approvalStatus}`)}</span>
      </div>
      <div className="row" style={{ marginTop: '0.75rem', alignItems: 'flex-start' }}>
        <div>
          <div className="muted small">{t('admin.zones.platePreview')}</div>
          <Plate zone={zone} />
          <div className="small" style={{ marginTop: 4 }}>
            {t('admin.zones.systemId')}: <code>{zone.examples.systemId}</code>
          </div>
        </div>
        <div style={{ flex: 1, minWidth: 220 }}>
          <p className="small">
            {t('admin.zones.wards', { count: zone.wardCount })} · {t('admin.zones.quota')}:{' '}
            {zone.vehicleQuota === null ? t('admin.zones.quotaUnset') : num(zone.vehicleQuota)} · v{num(zone.version)}
          </p>
          {zone.plateContrastOk ? (
            <p className="small muted">{t('admin.zones.contrastOk', { ratio: num(zone.plateContrast) })}</p>
          ) : (
            <p className="alert alert-warning small" data-testid="contrast-warning">
              {t('admin.zones.contrastBad', { ratio: num(zone.plateContrast) })}
            </p>
          )}
        </div>
      </div>
      {saved && <Notice kind="success">{t('admin.zones.updated')}</Notice>}
      <ErrorAlert error={error} />
      {editing ? (
        <form onSubmit={save} noValidate>
          <div className="grid2">
            <Field label={t('admin.zones.nameBn')} error={errors.nameBn} required>
              {(p) => <input {...p} name="nameBn" type="text" value={form.nameBn} onChange={set('nameBn')} />}
            </Field>
            <Field label={t('admin.zones.nameEn')} error={errors.nameEn} required>
              {(p) => <input {...p} name="nameEn" type="text" value={form.nameEn} onChange={set('nameEn')} />}
            </Field>
            <Field label={t('admin.zones.uiColour')} error={errors.uiColour} required>
              {(p) => (
                <div className="row">
                  <input type="color" value={form.uiColour} onChange={set('uiColour')} aria-label={t('admin.zones.uiColour')} />
                  <input {...p} name="uiColour" type="text" value={form.uiColour} onChange={set('uiColour')} style={{ maxWidth: 140 }} />
                </div>
              )}
            </Field>
            <Field label={t('admin.zones.plateColour')} error={errors.plateBackgroundColour} required>
              {(p) => (
                <div className="row">
                  <input type="color" value={form.plateBackgroundColour} onChange={set('plateBackgroundColour')} aria-label={t('admin.zones.plateColour')} />
                  <input {...p} name="plateBackgroundColour" type="text" value={form.plateBackgroundColour} onChange={set('plateBackgroundColour')} style={{ maxWidth: 140 }} />
                </div>
              )}
            </Field>
            <Field label={t('admin.zones.areaCode')} error={errors.plateAreaCodeBn} required>
              {(p) => <input {...p} name="plateAreaCodeBn" type="text" value={form.plateAreaCodeBn} onChange={set('plateAreaCodeBn')} maxLength={4} />}
            </Field>
            <Field label={t('admin.zones.quota')} error={errors.vehicleQuota} required={false}>
              {(p) => <input {...p} name="vehicleQuota" type="number" min={0} value={form.vehicleQuota} onChange={set('vehicleQuota')} />}
            </Field>
            <Field label={t('admin.zones.approval')} error={errors.approvalStatus} required>
              {(p) => (
                <select {...p} name="approvalStatus" value={form.approvalStatus} onChange={set('approvalStatus')}>
                  {['DRAFT', 'PROPOSED', 'APPROVED'].map((s) => (
                    <option key={s} value={s}>
                      {tk(`approval.${s}`)}
                    </option>
                  ))}
                </select>
              )}
            </Field>
            <Field label={t('admin.zones.changeNote')} error={errors.changeNote} required>
              {(p) => <input {...p} name="changeNote" type="text" value={form.changeNote} onChange={set('changeNote')} />}
            </Field>
          </div>
          <div className="row">
            <button className="btn" type="submit" disabled={busy || !form.changeNote.trim()}>
              {busy ? t('common.saving') : t('common.save')}
            </button>
            <button className="btn btn-secondary" type="button" onClick={() => setEditing(false)}>
              {t('common.cancel')}
            </button>
          </div>
        </form>
      ) : (
        <div className="row">
          {canManage && (
            <button className="btn btn-secondary" type="button" onClick={() => setEditing(true)}>
              {t('common.edit')}
            </button>
          )}
          <button className="btn btn-ghost" type="button" onClick={toggleHistory} aria-expanded={!!history}>
            {t('admin.zones.history')}
          </button>
        </div>
      )}
      {history && (
        <ol className="timeline" style={{ marginTop: '0.75rem' }}>
          {history.map((v) => (
            <li key={v.version}>
              <strong>{t('admin.zones.version', { version: v.version })}</strong>{' '}
              <span className="muted small">
                {date(v.changedAt, true)} · {v.changedBy ?? '—'}
              </span>
              <div>{v.changeNote}</div>
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}

export default function Zones() {
  const me = useRequireStaff('zone.read');
  const { t } = useI18n();
  const [zones, setZones] = useState<Zone[] | null>(null);
  const [error, setError] = useState<unknown>(null);
  const load = useCallback(() => api<Zone[]>('/admin/zones').then(setZones).catch(setError), []);
  useEffect(() => {
    if (me) void load();
  }, [me, load]);
  if (!me || !zones) return error ? <ErrorAlert error={error} /> : <Spinner />;
  const canManage = me.permissions.includes('zone.manage');
  return (
    <>
      <h1>{t('admin.zones.title')}</h1>
      <Notice>{t('admin.zones.note')}</Notice>
      {zones.map((z) => (
        <ZoneCard key={z.id} zone={z} canManage={canManage} onSaved={(nz) => setZones((prev) => prev!.map((x) => (x.id === nz.id ? nz : x)))} />
      ))}
    </>
  );
}
