'use client';

import { Field, useI18n } from '@dscc/web-ui';

/** Step-up confirmation code for irreversible actions. */
export function TotpField({ value, onChange, error }: { value: string; onChange: (v: string) => void; error?: string }) {
  const { t } = useI18n();
  return (
    <Field label={t('wf.totp')} hint={t('wf.totpHint')} error={error} required>
      {(p) => (
        <input
          {...p}
          type="text"
          inputMode="numeric"
          autoComplete="one-time-code"
          maxLength={6}
          className="otp-input"
          value={value}
          onChange={(e) => onChange(e.target.value.replace(/\D/g, '').slice(0, 6))}
        />
      )}
    </Field>
  );
}
