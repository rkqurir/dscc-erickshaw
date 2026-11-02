import '@fontsource/noto-sans-bengali/400.css';
import '@fontsource/noto-sans-bengali/600.css';
import '@fontsource/noto-sans-bengali/700.css';
import '@dscc/web-ui/src/styles.css';
import type { Metadata, Viewport } from 'next';
import { cookies } from 'next/headers';
import { ReactNode } from 'react';
import { Shell } from '../components/shell';
import { Providers } from '../components/providers';

export const metadata: Metadata = {
  title: 'DSCC ই-রিকশা ব্যবস্থাপনা সিস্টেম',
  description: 'ঢাকা দক্ষিণ সিটি কর্পোরেশনের ই-রিকশা নিবন্ধন পোর্টাল',
};

export const viewport: Viewport = { width: 'device-width', initialScale: 1, themeColor: '#0b6e4f' };

export default async function RootLayout({ children }: { children: ReactNode }) {
  const lang = (await cookies()).get('lang')?.value === 'en' ? 'en' : 'bn';
  return (
    <html lang={lang}>
      <body>
        <Providers lang={lang}>
          <Shell>{children}</Shell>
        </Providers>
      </body>
    </html>
  );
}
