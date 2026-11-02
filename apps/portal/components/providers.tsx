'use client';

import { I18nProvider } from '@dscc/web-ui';
import { ReactNode } from 'react';
import { SessionProvider } from './session';

export function Providers({ lang, children }: { lang: 'bn' | 'en'; children: ReactNode }) {
  return (
    <I18nProvider initialLang={lang}>
      <SessionProvider>{children}</SessionProvider>
    </I18nProvider>
  );
}
