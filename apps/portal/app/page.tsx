'use client';

import { Spinner, useI18n } from '@dscc/web-ui';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect } from 'react';
import { useSession } from '../components/session';

export default function Home() {
  const { t } = useI18n();
  const { state } = useSession();
  const router = useRouter();
  useEffect(() => {
    if (state.status === 'ready') router.replace(state.me.hasConsent ? '/dashboard' : '/consent');
  }, [state, router]);
  if (state.status !== 'anonymous') return <Spinner />;
  return (
    <div className="narrow">
      <div className="card">
        <h1>{t('app.title')}</h1>
        <p>{t('dash.ownerMissingBody')}</p>
        <p className="muted small">{t('dash.quotaTitle')}</p>
        <Link href="/login" className="btn btn-block">
          {t('login.title')}
        </Link>
      </div>
    </div>
  );
}
