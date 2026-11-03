'use client';

import {
  ALLOWED_UPLOAD_MIME,
  BATTERY_TYPES,
  DOCUMENT_TYPE_LIST,
  MAX_UPLOAD_BYTES,
  SEAT_TYPES,
  applicationSubmitSchema,
  toAsciiDigits,
} from '@dscc/domain';
import { ApiError, ErrorAlert, Field, Notice, api, newIdempotencyKey, useI18n } from '@dscc/web-ui';
import { UiKey } from '@dscc/localization';
import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { FitnessCard } from './fitness-card';
import type { ApplicationDetail } from './types';

type Section = 'vehicle' | 'location' | 'driver' | 'declaration';
type FormState = Record<Section, Record<string, unknown>>;

interface Zone {
  id: string;
  code: string;
  nameBn: string;
  nameEn: string;
  uiColour: string;
  approvalStatus: string;
}
interface Ward {
  id: string;
  zoneId: string;
  number: number;
  nameBn: string;
  nameEn: string;
  isSample: boolean;
}
interface Manufacturer {
  id: string;
  nameBn: string;
  nameEn: string;
  isSample: boolean;
  models: { id: string; name: string; seatType: string; isSample: boolean }[];
}

const STEPS: { key: UiKey; sections: Section[] }[] = [
  { key: 'app.step.vehicle', sections: ['vehicle'] },
  { key: 'app.step.location', sections: ['location'] },
  { key: 'app.step.driver', sections: ['driver'] },
  { key: 'app.step.documents', sections: [] },
  { key: 'app.step.review', sections: ['declaration'] },
];

function fieldErrors(issues: { path: (string | number)[]; message: string }[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const i of issues) {
    const k = i.path.join('.');
    if (!out[k]) out[k] = /^[A-Z0-9_]+$/.test(i.message) ? i.message : 'INVALID';
  }
  return out;
}

export function ApplicationWizard({ initial, onSubmitted }: { initial: ApplicationDetail; onSubmitted: () => Promise<void> }) {
  const { t, tk, lang, date, num } = useI18n();
  const router = useRouter();
  const [form, setForm] = useState<FormState>(() => ({
    vehicle: { hasSpeedometer: false, ...(initial.form.vehicle ?? {}) },
    location: { ...(initial.form.location ?? {}) },
    driver: { ...(initial.form.driver ?? {}) },
    declaration: { ...(initial.form.declaration ?? {}) },
  }));
  const [docs, setDocs] = useState(initial.documents);
  const [step, setStep] = useState(0);
  const [zones, setZones] = useState<Zone[]>([]);
  const [wards, setWards] = useState<Ward[]>([]);
  const [models, setModels] = useState<Manufacturer[]>([]);
  const [saveState, setSaveState] = useState<{ status: 'idle' | 'saving' | 'saved' | 'error'; at?: Date }>({ status: 'idle' });
  const [serverErrors, setServerErrors] = useState<Record<string, string>>({});
  const [error, setError] = useState<unknown>(null);
  const [uploading, setUploading] = useState<string | null>(null);
  const [uploadError, setUploadError] = useState<{ type: string; err: unknown } | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const version = useRef(initial.version);
  const dirty = useRef(false);
  const idemKey = useRef(newIdempotencyKey());
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const saving = useRef<Promise<void> | null>(null);
  const correction = initial.status === 'CORRECTION_REQUESTED' ? initial.correction : null;
  // The certificate is for the rickshaw that was inspected: its identifying fields lock once an inspection is open.
  const vehicleLocked = !!initial.fitness.openInspectionId || !!initial.fitness.certificate;
  const hasCertificate = !!initial.fitness.certificate;

  useEffect(() => {
    void Promise.all([api<Zone[]>('/catalog/zones'), api<Manufacturer[]>('/catalog/models')])
      .then(([z, m]) => {
        setZones(z);
        setModels(m);
      })
      .catch(setError);
  }, []);

  const zoneId = form.location.zoneId as string | undefined;
  useEffect(() => {
    if (!zoneId) {
      setWards([]);
      return;
    }
    void api<Ward[]>(`/catalog/wards?zoneId=${zoneId}`).then(setWards).catch(setError);
  }, [zoneId]);

  const save = useCallback(async () => {
    if (!dirty.current) return;
    dirty.current = false;
    setSaveState({ status: 'saving' });
    const run = (async () => {
      try {
        const r = await api<{ version: number }>(`/applications/${initial.id}`, { method: 'PATCH', json: { version: version.current, form: formRef.current } });
        version.current = r.version;
        setSaveState({ status: 'saved', at: new Date() });
      } catch (e) {
        if (e instanceof ApiError && e.code === 'CONFLICT') {
          const fresh = await api<ApplicationDetail>(`/applications/${initial.id}`);
          version.current = fresh.version;
          dirty.current = true;
          saveTimer.current = setTimeout(() => void save(), 300);
        } else {
          dirty.current = true;
          setSaveState({ status: 'error' });
        }
      }
    })();
    saving.current = run;
    await run;
    saving.current = null;
  }, [initial.id]);

  const formRef = useRef(form);
  formRef.current = form;

  function update(section: Section, key: string, value: unknown) {
    setForm((f) => {
      const next = { ...f, [section]: { ...f[section], [key]: value } };
      if (section === 'location' && key === 'zoneId') next.location.wardId = '';
      if (section === 'vehicle' && key === 'seatType') next.vehicle.modelId = '';
      return next;
    });
    dirty.current = true;
    if (saveTimer.current) clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(() => void save(), 800);
  }

  useEffect(() => () => {
    if (saveTimer.current) clearTimeout(saveTimer.current);
  }, []);

  async function flush() {
    if (saveTimer.current) clearTimeout(saveTimer.current);
    if (saving.current) await saving.current;
    await save();
  }

  async function goTo(i: number) {
    await flush();
    setStep(i);
    window.scrollTo({ top: 0 });
  }

  const validation = useMemo(() => {
    const clean = (o: Record<string, unknown>) => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== '' && v !== undefined));
    const r = applicationSubmitSchema.safeParse({
      vehicle: clean(form.vehicle),
      location: clean(form.location),
      driver: clean(form.driver),
      declaration: clean(form.declaration),
    });
    return r.success ? {} : fieldErrors(r.error.issues);
  }, [form]);

  const [touchedSteps, setTouchedSteps] = useState<Set<number>>(new Set());
  const errFor = (path: string) => serverErrors[path] ?? (touchedSteps.has(step) ? validation[path] : undefined);

  const present = new Set(docs.map((d) => d.docType));
  const missingDocs = initial.requiredDocuments.filter((d) => !present.has(d));

  async function upload(docType: string, file: File) {
    setUploadError(null);
    if (file.size > MAX_UPLOAD_BYTES) {
      setUploadError({ type: docType, err: new ApiError(413, { code: 'FILE_TOO_LARGE', message: 'ফাইলের আকার সর্বোচ্চ ৫ MB হতে পারে।', messageEn: 'Files may be at most 5 MB.' }) });
      return;
    }
    setUploading(docType);
    try {
      const fd = new FormData();
      fd.append('docType', docType);
      fd.append('file', file);
      const d = await api<{ id: string; docType: string; mimeType: string; sizeBytes: number; originalName: string }>(`/applications/${initial.id}/documents`, {
        method: 'POST',
        body: fd,
      });
      setDocs((prev) => [...prev.filter((x) => x.docType !== docType), { ...d, uploadedAt: new Date().toISOString() }]);
    } catch (e) {
      setUploadError({ type: docType, err: e });
    } finally {
      setUploading(null);
    }
  }

  async function submit() {
    setTouchedSteps(new Set([0, 1, 2, 3, 4]));
    setError(null);
    setServerErrors({});
    if (Object.keys(validation).length || missingDocs.length || !hasCertificate) return;
    setSubmitting(true);
    try {
      await flush();
      await api(`/applications/${initial.id}/submit`, { method: 'POST', headers: { 'Idempotency-Key': idemKey.current } });
      await onSubmitted();
    } catch (e) {
      setError(e);
      if (e instanceof ApiError) {
        const f: Record<string, string> = {};
        for (const [k, v] of Object.entries(e.fields)) f[k] = v;
        setServerErrors(f);
        if (e.code !== 'APPLICATION_INCOMPLETE' && e.code !== 'DOCUMENTS_MISSING') idemKey.current = newIdempotencyKey();
      }
    } finally {
      setSubmitting(false);
    }
  }

  async function deleteDraft() {
    if (!window.confirm(t('app.form.deleteConfirm'))) return;
    try {
      await api(`/applications/${initial.id}`, { method: 'DELETE' });
      router.replace('/dashboard');
    } catch (e) {
      setError(e);
    }
  }

  const input = (section: Section, key: string, label: string, opts: { required?: boolean; type?: string; hint?: string; textarea?: boolean; inputMode?: 'numeric' | 'tel'; disabled?: boolean } = {}) => (
    <Field label={label} hint={opts.hint} required={opts.required ?? true} error={errFor(`${section}.${key}`)}>
      {(p) =>
        opts.textarea ? (
          <textarea {...p} name={`${section}.${key}`} value={(form[section][key] as string) ?? ''} onChange={(e) => update(section, key, e.target.value)} />
        ) : (
          <input
            {...p}
            name={`${section}.${key}`}
            type={opts.type ?? 'text'}
            inputMode={opts.inputMode}
            disabled={opts.disabled}
            value={(form[section][key] as string | number | undefined) ?? ''}
            onChange={(e) => update(section, key, opts.type === 'number' ? (e.target.value === '' ? '' : Number(toAsciiDigits(e.target.value))) : e.target.value)}
          />
        )
      }
    </Field>
  );

  const seatType = form.vehicle.seatType as string | undefined;
  const sectionLabel = (s: string) => {
    const st = STEPS.find((x) => x.sections.includes(s as Section));
    return st ? t(st.key) : s;
  };
  const problemSections = [...new Set(Object.keys(validation).map((k) => k.split('.')[0]))];

  return (
    <>
      <div className="row spread">
        <h1>{t('app.form.title')}</h1>
        <span className="muted small" aria-live="polite" data-testid="save-state">
          {saveState.status === 'saving' && t('common.saving')}
          {saveState.status === 'saved' && saveState.at && t('app.form.lastSaved', { time: date(saveState.at, true) })}
          {saveState.status === 'error' && t('app.form.saveError')}
          {saveState.status === 'idle' && t('app.form.autosave')}
        </span>
      </div>
      <ol className="stepper" aria-label={t('app.form.title')}>
        {STEPS.map((s, i) => (
          <li key={s.key}>
            <button type="button" aria-current={i === step ? 'step' : undefined} onClick={() => void goTo(i)}>
              {num(i + 1)}. {t(s.key)}
            </button>
          </li>
        ))}
      </ol>
      {correction && (
        <div className="alert alert-warning" role="note" data-testid="correction-notice">
          <strong>{t('cit.correctionTitle')}</strong>
          <p style={{ margin: '0.25rem 0' }}>{correction.message}</p>
          <p className="small" style={{ margin: 0 }}>
            {t('cit.correctionItems', {
              items: correction.items.map((i) => (['vehicle', 'location', 'driver'].includes(i) ? tk(`section.${i}`) : tk(`doc.${i}`))).join(', '),
            })}
          </p>
        </div>
      )}
      <ErrorAlert error={error} />
      <FitnessCard app={initial} onChange={onSubmitted} beforeRequest={flush} />

      <div className="card">
        {step === 0 && (
          <>
            <h2>{t('app.step.vehicle')}</h2>
            {vehicleLocked && <Notice>{t('fitc.locked')}</Notice>}
            <div className="grid2">
              <Field label={t('vehicle.seatType')} required error={errFor('vehicle.seatType')}>
                {(p) => (
                  <select {...p} name="vehicle.seatType" value={seatType ?? ''} onChange={(e) => update('vehicle', 'seatType', e.target.value)} disabled={vehicleLocked}>
                    <option value="">—</option>
                    {SEAT_TYPES.map((s) => (
                      <option key={s} value={s}>
                        {tk(`seat.${s}`)}
                      </option>
                    ))}
                  </select>
                )}
              </Field>
              <Field label={t('vehicle.model')} hint={t('vehicle.modelSampleNote')} required error={errFor('vehicle.modelId')}>
                {(p) => (
                  <select {...p} name="vehicle.modelId" value={(form.vehicle.modelId as string) ?? ''} onChange={(e) => update('vehicle', 'modelId', e.target.value)} disabled={!seatType || vehicleLocked}>
                    <option value="">{t('vehicle.modelPlaceholder')}</option>
                    {models.map((m) => (
                      <optgroup key={m.id} label={lang === 'bn' ? m.nameBn : m.nameEn}>
                        {m.models
                          .filter((x) => x.seatType === seatType)
                          .map((x) => (
                            <option key={x.id} value={x.id}>
                              {x.name}
                            </option>
                          ))}
                      </optgroup>
                    ))}
                  </select>
                )}
              </Field>
              {input('vehicle', 'manufactureYear', t('vehicle.year'), { type: 'number', inputMode: 'numeric' })}
              <Field label={t('vehicle.battery')} required error={errFor('vehicle.batteryType')}>
                {(p) => (
                  <select {...p} name="vehicle.batteryType" value={(form.vehicle.batteryType as string) ?? ''} onChange={(e) => update('vehicle', 'batteryType', e.target.value)}>
                    <option value="">—</option>
                    {BATTERY_TYPES.map((b) => (
                      <option key={b} value={b}>
                        {tk(`battery.${b}`)}
                      </option>
                    ))}
                  </select>
                )}
              </Field>
              {input('vehicle', 'chassisNo', t('vehicle.chassis'), { disabled: vehicleLocked })}
              {input('vehicle', 'motorNo', t('vehicle.motor'), { disabled: vehicleLocked })}
              {input('vehicle', 'insurancePolicyNo', t('vehicle.insurance'), { required: false })}
              {input('vehicle', 'colour', t('vehicle.colour'), { required: false })}
            </div>
            <label className="check">
              <input type="checkbox" name="vehicle.hasSpeedometer" checked={!!form.vehicle.hasSpeedometer} onChange={(e) => update('vehicle', 'hasSpeedometer', e.target.checked)} />
              <span>{t('vehicle.speedometer')}</span>
            </label>
          </>
        )}

        {step === 1 && (
          <>
            <h2>{t('app.step.location')}</h2>
            <Notice>{t('location.zoneNote')}</Notice>
            <fieldset className="field" style={{ border: 'none', padding: 0 }}>
              <legend style={{ fontWeight: 600 }}>
                {t('location.zone')} <span className="req">*</span>
              </legend>
              <div className="row">
                {zones.map((z) => (
                  <label key={z.id} className="check" style={{ border: '1px solid var(--line)', borderRadius: 8, padding: '0.5rem 0.75rem' }}>
                    <input type="radio" name="location.zoneId" value={z.id} checked={zoneId === z.id} onChange={() => update('location', 'zoneId', z.id)} />
                    <span className="zone-chip">
                      <span className="swatch" style={{ background: z.uiColour }} aria-hidden="true" />
                      {z.code} · {lang === 'bn' ? z.nameBn : z.nameEn}
                    </span>
                  </label>
                ))}
              </div>
              {errFor('location.zoneId') && <p className="field-error">{tk(`field.${errFor('location.zoneId')}`)}</p>}
            </fieldset>
            <Field label={t('location.ward')} hint={wards.some((w) => w.isSample) ? t('location.wardSample') : undefined} required error={errFor('location.wardId')}>
              {(p) => (
                <select {...p} name="location.wardId" value={(form.location.wardId as string) ?? ''} onChange={(e) => update('location', 'wardId', e.target.value)} disabled={!zoneId}>
                  <option value="">{t('location.wardPlaceholder')}</option>
                  {wards.map((w) => (
                    <option key={w.id} value={w.id}>
                      {lang === 'bn' ? w.nameBn : w.nameEn}
                    </option>
                  ))}
                </select>
              )}
            </Field>
            {input('location', 'chargingLocation', t('location.charging'), { textarea: true })}
          </>
        )}

        {step === 2 && (
          <>
            <h2>{t('app.step.driver')}</h2>
            <div className="grid2">
              {input('driver', 'nameBn', t('driver.nameBn'))}
              {input('driver', 'nameEn', t('driver.nameEn'), { required: false })}
              {input('driver', 'nid', t('driver.nid'), { hint: t('owner.nidHint'), inputMode: 'numeric' })}
              {input('driver', 'dateOfBirth', t('driver.dob'), { type: 'date' })}
              {input('driver', 'phone', t('driver.phone'), { type: 'tel', inputMode: 'tel', hint: t('login.phoneHint').split('।')[0] })}
              {input('driver', 'trainingCertificateNo', t('driver.training'), { required: false })}
            </div>
            {input('driver', 'address', t('driver.address'), { textarea: true })}
          </>
        )}

        {step === 3 && (
          <>
            <h2>{t('app.step.documents')}</h2>
            <p className="muted">{t('docs.intro')}</p>
            <div className="table-wrap">
              <table className="responsive">
                <tbody>
                  {DOCUMENT_TYPE_LIST.map((type) => {
                    const doc = docs.find((d) => d.docType === type);
                    const required = initial.requiredDocuments.includes(type);
                    return (
                      <tr key={type} data-testid={`doc-${type}`}>
                        <td>
                          <strong>{tk(`doc.${type}`)}</strong> {required ? <span className="req">*</span> : <span className="opt muted small">({t('common.optional')})</span>}
                          {uploadError?.type === type && <ErrorAlert error={uploadError.err} />}
                        </td>
                        <td>
                          {doc ? (
                            <span className="badge badge-approved">
                              {t('docs.uploaded')}: {doc.originalName}
                            </span>
                          ) : required ? (
                            <span className="badge badge-at_risk">{t('docs.missing')}</span>
                          ) : (
                            '—'
                          )}
                        </td>
                        <td>
                          <label className="btn btn-secondary" style={{ cursor: uploading ? 'wait' : 'pointer' }}>
                            {uploading === type ? t('docs.uploading') : doc ? t('docs.replace') : t('docs.upload')}
                            <input
                              type="file"
                              accept={ALLOWED_UPLOAD_MIME.join(',')}
                              style={{ position: 'absolute', width: 1, height: 1, opacity: 0 }}
                              aria-label={`${tk(`doc.${type}`)} — ${t('docs.upload')}`}
                              disabled={!!uploading}
                              onChange={(e) => {
                                const f = e.target.files?.[0];
                                e.target.value = '';
                                if (f) void upload(type, f);
                              }}
                            />
                          </label>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </>
        )}

        {step === 4 && (
          <>
            <h2>{t('app.step.review')}</h2>
            <p className="alert alert-info">{t('review.fee')}</p>
            {touchedSteps.has(4) && (problemSections.length > 0 || missingDocs.length > 0 || !hasCertificate) && (
              <div className="alert alert-error" role="alert" data-testid="review-problems">
                <p style={{ margin: 0 }}>{t('review.problems')}</p>
                <ul>
                  {problemSections
                    .filter((s) => s !== 'declaration')
                    .map((s) => (
                      <li key={s}>
                        <button type="button" className="btn btn-ghost" onClick={() => void goTo(STEPS.findIndex((x) => x.sections.includes(s as Section)))}>
                          {t('review.incompleteSection', { section: sectionLabel(s) })}
                        </button>
                      </li>
                    ))}
                  {missingDocs.length > 0 && <li>{t('review.missingDocs', { docs: missingDocs.map((d) => tk(`doc.${d}`)).join(', ') })}</li>}
                  {!hasCertificate && <li data-testid="review-fitness-missing">{t('review.fitnessMissing')}</li>}
                </ul>
              </div>
            )}
            <label className="check">
              <input type="checkbox" name="declaration.truthful" checked={form.declaration.truthful === true} onChange={(e) => update('declaration', 'truthful', e.target.checked ? true : undefined)} />
              <span>{t('review.declaration')}</span>
            </label>
            {errFor('declaration.truthful') && <p className="field-error">{tk(`field.${errFor('declaration.truthful')}`)}</p>}
            <button className="btn btn-block" type="button" onClick={submit} disabled={submitting}>
              {submitting ? t('review.submitting') : correction ? t('cit.resubmit') : t('review.submit')}
            </button>
          </>
        )}
      </div>

      <div className="row spread">
        <div className="row">
          {step > 0 && (
            <button type="button" className="btn btn-secondary" onClick={() => void goTo(step - 1)}>
              {t('common.previous')}
            </button>
          )}
          {step < STEPS.length - 1 && (
            <button
              type="button"
              className="btn"
              onClick={() => {
                setTouchedSteps((s) => new Set(s).add(step));
                void goTo(step + 1);
              }}
            >
              {t('common.next')}
            </button>
          )}
        </div>
        {!correction && (
          <button type="button" className="btn btn-ghost" onClick={deleteDraft}>
            {t('app.form.deleteDraft')}
          </button>
        )}
      </div>
    </>
  );
}
