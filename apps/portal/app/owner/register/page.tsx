'use client';

import { EDUCATION_LEVELS, ownerIdentitySchema } from '@dscc/domain';
import { ApiError, ErrorAlert, Field, Notice, Spinner, api, useI18n } from '@dscc/web-ui';
import { useRouter } from 'next/navigation';
import { FormEvent, useEffect, useState } from 'react';
import { useRequireCitizen, useSession } from '../../../components/session';

type Form = {
  nid: string;
  dateOfBirth: string;
  nameBn: string;
  nameEn: string;
  fatherNameBn: string;
  motherNameBn: string;
  presentAddress: string;
  permanentAddress: string;
  education: string;
  declareCitizen: boolean;
  declareSoundMind: boolean;
};

const EMPTY: Form = {
  nid: '',
  dateOfBirth: '',
  nameBn: '',
  nameEn: '',
  fatherNameBn: '',
  motherNameBn: '',
  presentAddress: '',
  permanentAddress: '',
  education: '',
  declareCitizen: false,
  declareSoundMind: false,
};

function zodFieldErrors(issues: { path: (string | number)[]; message: string }[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const i of issues) {
    const k = i.path.join('.');
    if (!out[k]) out[k] = /^[A-Z0-9_]+$/.test(i.message) ? i.message : 'INVALID';
  }
  return out;
}

export default function OwnerRegister() {
  const me = useRequireCitizen();
  const { refresh } = useSession();
  const { t, tk } = useI18n();
  const router = useRouter();
  const [form, setForm] = useState<Form>(EMPTY);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const [linked, setLinked] = useState(false);

  useEffect(() => {
    if (me?.owner && !linked) router.replace('/dashboard');
  }, [me, router, linked]);
  if (!me) return <Spinner />;

  const set = (k: keyof Form) => (e: { target: { value: string; checked?: boolean; type?: string } }) =>
    setForm((f) => ({ ...f, [k]: e.target.type === 'checkbox' ? !!e.target.checked : e.target.value }));

  async function submit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    const payload = { ...form, nameEn: form.nameEn || undefined };
    const v = ownerIdentitySchema.safeParse(payload);
    if (!v.success) {
      setErrors(zodFieldErrors(v.error.issues));
      return;
    }
    setErrors({});
    setBusy(true);
    try {
      const r = await api<{ linkedExisting: boolean }>('/owners/me/identity', { method: 'POST', json: payload });
      if (r.linkedExisting) setLinked(true);
      await refresh();
      if (!r.linkedExisting) router.replace('/dashboard');
    } catch (err) {
      setError(err);
      if (err instanceof ApiError) setErrors(err.fields);
    } finally {
      setBusy(false);
    }
  }

  if (linked) {
    return (
      <div className="narrow">
        <Notice kind="success">{t('owner.linked')}</Notice>
        <button className="btn" type="button" onClick={() => router.replace('/dashboard')}>
          {t('dash.title')}
        </button>
      </div>
    );
  }

  const text = (k: keyof Form, label: string, opts: { required?: boolean; hint?: string; textarea?: boolean; inputMode?: 'numeric' } = {}) => (
    <Field label={label} hint={opts.hint} error={errors[k]} required={opts.required ?? true}>
      {(p) =>
        opts.textarea ? (
          <textarea {...p} name={k} value={form[k] as string} onChange={set(k)} />
        ) : (
          <input {...p} type="text" name={k} inputMode={opts.inputMode} value={form[k] as string} onChange={set(k)} />
        )
      }
    </Field>
  );

  return (
    <div className="narrow" style={{ maxWidth: 760 }}>
      <h1>{t('owner.title')}</h1>
      <p className="muted">{t('owner.intro')}</p>
      <ErrorAlert error={error} />
      <form className="card" onSubmit={submit} noValidate>
        <div className="grid2">
          {text('nid', t('owner.nid'), { hint: t('owner.nidHint'), inputMode: 'numeric' })}
          <Field label={t('owner.dob')} error={errors.dateOfBirth} required>
            {(p) => <input {...p} type="date" name="dateOfBirth" value={form.dateOfBirth} onChange={set('dateOfBirth')} />}
          </Field>
          {text('nameBn', t('owner.nameBn'))}
          {text('nameEn', t('owner.nameEn'), { required: false })}
          {text('fatherNameBn', t('owner.father'))}
          {text('motherNameBn', t('owner.mother'))}
        </div>
        {text('presentAddress', t('owner.presentAddress'), { textarea: true })}
        {text('permanentAddress', t('owner.permanentAddress'), { textarea: true })}
        <Field label={t('owner.education')} error={errors.education} required>
          {(p) => (
            <select {...p} name="education" value={form.education} onChange={set('education')}>
              <option value="">—</option>
              {EDUCATION_LEVELS.map((l) => (
                <option key={l} value={l}>
                  {tk(`education.${l}`)}
                </option>
              ))}
            </select>
          )}
        </Field>
        <label className="check">
          <input type="checkbox" name="declareCitizen" checked={form.declareCitizen} onChange={set('declareCitizen')} />
          <span>{t('owner.declareCitizen')}</span>
        </label>
        {errors.declareCitizen && <p className="field-error">{tk(`field.${errors.declareCitizen}`)}</p>}
        <label className="check">
          <input type="checkbox" name="declareSoundMind" checked={form.declareSoundMind} onChange={set('declareSoundMind')} />
          <span>{t('owner.declareSoundMind')}</span>
        </label>
        {errors.declareSoundMind && <p className="field-error">{tk(`field.${errors.declareSoundMind}`)}</p>}
        <button className="btn btn-block" type="submit" disabled={busy}>
          {t('owner.submit')}
        </button>
      </form>
    </div>
  );
}
