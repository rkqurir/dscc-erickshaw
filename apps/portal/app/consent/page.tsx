'use client';

import { ErrorAlert, Spinner, api, useI18n } from '@dscc/web-ui';
import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import { useSession } from '../../components/session';

export default function ConsentPage() {
  const { t } = useI18n();
  const { state, refresh } = useSession();
  const router = useRouter();
  const [checked, setChecked] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (state.status === 'anonymous') router.replace('/login');
    if (state.status === 'ready' && state.me.hasConsent) router.replace('/dashboard');
  }, [state, router]);
  if (state.status !== 'ready' || state.me.hasConsent) return <Spinner />;

  async function accept() {
    if (state.status !== 'ready') return;
    setBusy(true);
    setError(null);
    try {
      await api('/me/consent', { method: 'POST', json: { noticeVersion: state.me.privacyNoticeVersion } });
      await refresh();
      router.replace('/dashboard');
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="narrow">
      <div className="card">
        <h1>{t('consent.title')}</h1>
        <p>{t('consent.body1')}</p>
        <p>{t('consent.body2')}</p>
        <p>{t('consent.body3')}</p>
        <ErrorAlert error={error} />
        <label className="check">
          <input type="checkbox" checked={checked} onChange={(e) => setChecked(e.target.checked)} />
          <span>{t('consent.checkbox')}</span>
        </label>
        <button className="btn btn-block" type="button" disabled={!checked || busy} onClick={accept}>
          {t('consent.accept')}
        </button>
      </div>
    </div>
  );
}
