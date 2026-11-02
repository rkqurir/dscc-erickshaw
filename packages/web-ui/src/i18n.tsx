'use client';

import { Lang, UiKey, hasKey, t as translate } from '@dscc/localization';
import { toBengaliDigits } from '@dscc/domain';
import { createContext, ReactNode, useCallback, useContext, useMemo, useState } from 'react';

interface I18n {
  lang: Lang;
  t: (key: UiKey, vars?: Record<string, string | number>) => string;
  /** Translate a dynamic key (e.g. `status.${s}`), falling back to the raw value. */
  tk: (key: string, vars?: Record<string, string | number>) => string;
  num: (n: number | string) => string;
  date: (iso: string | Date | null | undefined, withTime?: boolean) => string;
  setLang: (l: Lang) => void;
}

const Ctx = createContext<I18n | null>(null);

export function I18nProvider({ initialLang, children }: { initialLang: Lang; children: ReactNode }) {
  const [lang, setLangState] = useState<Lang>(initialLang);
  const setLang = useCallback((l: Lang) => {
    document.cookie = `lang=${l}; path=/; max-age=31536000; samesite=lax`;
    document.documentElement.lang = l;
    setLangState(l);
  }, []);
  const value = useMemo<I18n>(() => {
    const num = (n: number | string) => (lang === 'bn' ? toBengaliDigits(String(n)) : String(n));
    const fmtVars = (vars?: Record<string, string | number>) =>
      vars ? Object.fromEntries(Object.entries(vars).map(([k, v]) => [k, typeof v === 'number' ? num(v) : v])) : undefined;
    return {
      lang,
      t: (key, vars) => translate(lang, key, fmtVars(vars)),
      tk: (key, vars) => (hasKey(key) ? translate(lang, key, fmtVars(vars)) : key),
      num,
      date: (iso, withTime = false) => {
        if (!iso) return '—';
        const d = typeof iso === 'string' ? new Date(iso.length === 10 ? `${iso}T00:00:00+06:00` : iso) : iso;
        return new Intl.DateTimeFormat(lang === 'bn' ? 'bn-BD' : 'en-GB', {
          timeZone: 'Asia/Dhaka',
          day: 'numeric',
          month: 'long',
          year: 'numeric',
          ...(withTime ? { hour: '2-digit', minute: '2-digit' } : {}),
        }).format(d);
      },
      setLang,
    };
  }, [lang, setLang]);
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useI18n(): I18n {
  const v = useContext(Ctx);
  if (!v) throw new Error('useI18n outside I18nProvider');
  return v;
}

export function LangToggle() {
  const { lang, setLang, t } = useI18n();
  return (
    <button type="button" className="btn btn-ghost" onClick={() => setLang(lang === 'bn' ? 'en' : 'bn')} lang={lang === 'bn' ? 'en' : 'bn'}>
      {t('lang.switch')}
    </button>
  );
}
