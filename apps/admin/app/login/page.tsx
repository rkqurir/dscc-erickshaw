'use client';

import { toAsciiDigits } from '@dscc/domain';
import { ErrorAlert, Field, api, useI18n } from '@dscc/web-ui';
import { useRouter } from 'next/navigation';
import { FormEvent, useState } from 'react';
import { useStaffSession } from '../../components/session';

type Stage = { kind: 'password' } | { kind: 'enroll'; qrDataUrl: string; secret: string } | { kind: 'mfa' };

export default function StaffLogin() {
  const { t } = useI18n();
  const router = useRouter();
  const { refresh } = useStaffSession();
  const [stage, setStage] = useState<Stage>({ kind: 'password' });
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [code, setCode] = useState('');
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);

  async function login(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      const r = await api<{ mfaEnrolled: boolean }>('/staff/auth/login', { method: 'POST', json: { email, password } });
      setPassword('');
      if (r.mfaEnrolled) setStage({ kind: 'mfa' });
      else {
        const en = await api<{ qrDataUrl: string; secret: string }>('/staff/auth/mfa/enrollment');
        setStage({ kind: 'enroll', qrDataUrl: en.qrDataUrl, secret: en.secret });
      }
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  }

  async function verify(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      await api('/staff/auth/mfa/verify', { method: 'POST', json: { code } });
      await refresh();
      router.replace('/');
    } catch (err) {
      setError(err);
      setCode('');
    } finally {
      setBusy(false);
    }
  }

  const codeField = (
    <Field label={t('staff.mfa.code')} required>
      {(p) => (
        <input
          {...p}
          name="totp"
          className="otp-input"
          inputMode="numeric"
          autoComplete="one-time-code"
          maxLength={6}
          value={code}
          onChange={(e) => setCode(toAsciiDigits(e.target.value).replace(/\D/g, '').slice(0, 6))}
        />
      )}
    </Field>
  );

  return (
    <div className="narrow">
      <div className="card">
        {stage.kind === 'password' && (
          <form onSubmit={login}>
            <h1>{t('staff.login.title')}</h1>
            <ErrorAlert error={error} />
            <Field label={t('staff.login.email')} required>
              {(p) => <input {...p} name="email" type="email" autoComplete="username" value={email} onChange={(e) => setEmail(e.target.value)} />}
            </Field>
            <Field label={t('staff.login.password')} required>
              {(p) => (
                <input {...p} name="password" type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} />
              )}
            </Field>
            <button className="btn btn-block" type="submit" disabled={busy || !email || !password}>
              {t('staff.login.submit')}
            </button>
          </form>
        )}
        {stage.kind === 'enroll' && (
          <form onSubmit={verify}>
            <h1>{t('staff.mfa.enrollTitle')}</h1>
            <p>{t('staff.mfa.enrollBody')}</p>
            <div className="qr-box">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={stage.qrDataUrl} alt="TOTP QR" width={220} height={220} />
            </div>
            <p className="small muted" data-testid="totp-secret">
              {t('staff.mfa.secret', { secret: stage.secret })}
            </p>
            <ErrorAlert error={error} />
            {codeField}
            <button className="btn btn-block" type="submit" disabled={busy || code.length !== 6}>
              {t('staff.mfa.verify')}
            </button>
          </form>
        )}
        {stage.kind === 'mfa' && (
          <form onSubmit={verify}>
            <h1>{t('staff.mfa.title')}</h1>
            <p>{t('staff.mfa.body')}</p>
            <ErrorAlert error={error} />
            {codeField}
            <button className="btn btn-block" type="submit" disabled={busy || code.length !== 6}>
              {t('staff.mfa.verify')}
            </button>
          </form>
        )}
      </div>
    </div>
  );
}
