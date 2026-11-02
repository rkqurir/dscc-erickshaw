'use client';

import { I18nProvider } from '@dscc/web-ui';
import { ReactNode } from 'react';
import { StaffSessionProvider } from './session';

export function Providers({ lang, children }: { lang: 'bn' | 'en'; children: ReactNode }) {
  return (
    <I18nProvider initialLang={lang}>
      <StaffSessionProvider>{children}</StaffSessionProvider>
    </I18nProvider>
  );
}
