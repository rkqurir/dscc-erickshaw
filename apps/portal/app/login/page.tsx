'use client';

import { normalizeBdMobile, toAsciiDigits } from '@dscc/domain';
import { ApiError, ErrorAlert, Field, api, useI18n } from '@dscc/web-ui';
import { useRouter } from 'next/navigation';
import { FormEvent, useEffect, useState } from 'react';
import { useSession } from '../../components/session';

interface OtpRequest {
  challengeId: string;
  expiresInSeconds: number;
  resendAfterSeconds: number;
}

export default function LoginPage() {
  const { t, num } = useI18n();
  const router = useRouter();
  const { refresh } = useSession();
  const [phone, setPhone] = useState('');
  const [phoneError, setPhoneError] = useState<string>();
  const [challenge, setChallenge] = useState<OtpRequest | null>(null);
  const [code, setCode] = useState('');
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const [cooldown, setCooldown] = useState(0);

  useEffect(() => {
    if (cooldown <= 0) return;
    const id = setTimeout(() => setCooldown((c) => c - 1), 1000);
    return () => clearTimeout(id);
  }, [cooldown]);

  async function requestOtp(e?: FormEvent) {
    e?.preventDefault();
    setError(null);
    if (!normalizeBdMobile(phone)) {
      setPhoneError('PHONE_INVALID');
      return;
    }
    setPhoneError(undefined);
    setBusy(true);
    try {
      const r = await api<OtpRequest>('/auth/otp/request', { method: 'POST', json: { phone } });
      setChallenge(r);
      setCode('');
      setCooldown(r.resendAfterSeconds);
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  }

  async function verify(e: FormEvent) {
    e.preventDefault();
    if (!challenge) return;
    setError(null);
    setBusy(true);
    try {
      const r = await api<{ needsConsent: boolean }>('/auth/otp/verify', {
        method: 'POST',
        json: { challengeId: challenge.challengeId, code: toAsciiDigits(code.trim()) },
      });
      await refresh();
      router.replace(r.needsConsent ? '/consent' : '/dashboard');
    } catch (err) {
      setError(err);
      if (err instanceof ApiError && err.code === 'OTP_INVALID') setCode('');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="narrow">
      <div className="card">
        <h1>{t('login.title')}</h1>
        <ErrorAlert error={error} />
        {!challenge ? (
          <form onSubmit={requestOtp} noValidate>
            <Field label={t('login.phoneLabel')} hint={t('login.phoneHint')} error={phoneError} required>
              {(p) => (
                <input
                  {...p}
                  type="tel"
                  inputMode="tel"
                  autoComplete="tel-national"
                  value={phone}
                  onChange={(e) => setPhone(e.target.value)}
                  name="phone"
                />
              )}
            </Field>
            <button className="btn btn-block" type="submit" disabled={busy}>
              {t('login.sendOtp')}
            </button>
          </form>
        ) : (
          <form onSubmit={verify} noValidate>
            <p className="alert alert-info">{t('login.otpSent', { phone: num(phone) })}</p>
            <Field label={t('login.otpLabel')} required>
              {(p) => (
                <input
                  {...p}
                  className="otp-input"
                  type="text"
                  inputMode="numeric"
                  autoComplete="one-time-code"
                  maxLength={6}
                  value={code}
                  onChange={(e) => setCode(toAsciiDigits(e.target.value).replace(/\D/g, '').slice(0, 6))}
                  name="otp"
                />
              )}
            </Field>
            <button className="btn btn-block" type="submit" disabled={busy || code.length !== 6}>
              {t('login.verify')}
            </button>
            <div className="row spread" style={{ marginTop: '0.75rem' }}>
              <button type="button" className="btn btn-ghost" onClick={() => setChallenge(null)}>
                {t('login.changeNumber')}
              </button>
              {cooldown > 0 ? (
                <span className="muted small" aria-live="polite">
                  {t('login.resendIn', { seconds: cooldown })}
                </span>
              ) : (
                <button type="button" className="btn btn-ghost" onClick={() => void requestOtp()} disabled={busy}>
                  {t('login.resend')}
                </button>
              )}
            </div>
          </form>
        )}
      </div>
    </div>
  );
}
