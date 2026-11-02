'use client';

import { LangToggle, useI18n } from '@dscc/web-ui';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { ReactNode } from 'react';
import { useSession } from './session';

export function Shell({ children }: { children: ReactNode }) {
  const { t } = useI18n();
  const { state, logout } = useSession();
  const router = useRouter();
  return (
    <>
      <a href="#main" className="skip-link">
        {t('common.skipToContent')}
      </a>
      <header className="topbar">
        <div className="topbar-inner">
          <Link href={state.status === 'ready' ? '/dashboard' : '/'} className="brand">
            {t('app.title')}
            <small>{t('app.city')}</small>
          </Link>
          <nav aria-label="account">
            <LangToggle />
            {state.status === 'ready' && (
              <button
                type="button"
                className="btn btn-ghost"
                onClick={async () => {
                  await logout();
                  router.replace('/login');
                }}
              >
                {t('common.logout')}
              </button>
            )}
          </nav>
        </div>
      </header>
      {process.env.NEXT_PUBLIC_DEMO_MODE !== 'false' && <div className="demo-banner">{t('app.demoBanner')}</div>}
      <main id="main">{children}</main>
      <footer className="site">
        {t('app.city')} · {t('app.operator')}
      </footer>
    </>
  );
}
