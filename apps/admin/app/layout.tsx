import '@fontsource/noto-sans-bengali/400.css';
import '@fontsource/noto-sans-bengali/600.css';
import '@fontsource/noto-sans-bengali/700.css';
import '@dscc/web-ui/src/styles.css';
import type { Metadata, Viewport } from 'next';
import { cookies } from 'next/headers';
import { ReactNode } from 'react';
import { AdminShell } from '../components/shell';
import { Providers } from '../components/providers';

export const metadata: Metadata = {
  title: 'DSCC অ্যাডমিন ড্যাশবোর্ড',
  description: 'ঢাকা দক্ষিণ সিটি কর্পোরেশন — ই-রিকশা অ্যাডমিন',
  robots: { index: false, follow: false },
};

export const viewport: Viewport = { width: 'device-width', initialScale: 1, themeColor: '#0b6e4f' };

export default async function RootLayout({ children }: { children: ReactNode }) {
  const lang = (await cookies()).get('lang')?.value === 'en' ? 'en' : 'bn';
  return (
    <html lang={lang}>
      <body>
        <Providers lang={lang}>
          <AdminShell>{children}</AdminShell>
        </Providers>
      </body>
    </html>
  );
}
