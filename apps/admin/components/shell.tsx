'use client';

import { LangToggle, useI18n } from '@dscc/web-ui';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { ReactNode } from 'react';
import { useStaffSession } from './session';

/** Menu entries appear only for modules that exist and that the officer is permitted to use. */
const MENU = [
  { href: '/applications', key: 'nav.applications', permission: 'application.read' },
  { href: '/zones', key: 'nav.zones', permission: 'zone.read' },
] as const;

export function AdminShell({ children }: { children: ReactNode }) {
  const { t } = useI18n();
  const { state, logout } = useStaffSession();
  const pathname = usePathname();
  const router = useRouter();
  const perms = state.status === 'ready' ? state.me.permissions : [];
  return (
    <>
      <a href="#main" className="skip-link">
        {t('common.skipToContent')}
      </a>
      <header className="topbar">
        <div className="topbar-inner">
          <Link href="/" className="brand">
            {t('app.adminTitle')}
            <small>{t('app.city')}</small>
          </Link>
          <nav aria-label="main">
            {state.status === 'ready' &&
              MENU.filter((m) => perms.includes(m.permission)).map((m) => (
                <Link key={m.href} href={m.href} aria-current={pathname.startsWith(m.href) ? 'page' : undefined}>
                  {t(m.key)}
                </Link>
              ))}
            <LangToggle />
            {state.status === 'ready' && (
              <>
                <span className="small" data-testid="staff-name">
                  {t('admin.signedInAs', { name: state.me.fullName, roles: state.me.roles.join(', ') })}
                </span>
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
              </>
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
