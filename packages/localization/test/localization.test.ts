import { describe, expect, it } from 'vitest';
import { errorMessages, errorMessage, t, uiMessages } from '../src';

const placeholders = (s: string) => (s.match(/\{[a-zA-Z]+\}/g) ?? []).sort();

describe('localization', () => {
  it('has identical keys and placeholders in Bengali and English', () => {
    expect(Object.keys(uiMessages.en).sort()).toEqual(Object.keys(uiMessages.bn).sort());
    for (const k of Object.keys(uiMessages.bn) as (keyof typeof uiMessages.bn)[]) {
      expect(placeholders(uiMessages.en[k]), k).toEqual(placeholders(uiMessages.bn[k]));
    }
  });
  it('has Bengali text for every Bengali string and error', () => {
    for (const [k, v] of Object.entries(uiMessages.bn)) {
      if (k === 'lang.switch' || k === 'admin.signedInAs') continue; // language name / pure placeholders
      expect(/[ঀ-৿]/.test(v) || /^[A-Z0-9 ()–-]+$/.test(v), k).toBe(true);
    }
    for (const [k, v] of Object.entries(errorMessages)) expect(/[ঀ-৿]/.test(v.bn), k).toBe(true);
  });
  it('interpolates and falls back for unknown error codes', () => {
    expect(t('bn', 'login.resendIn', { seconds: '৫৯' })).toBe('৫৯ সেকেন্ড পরে আবার OTP পাঠানো যাবে');
    expect(errorMessage('NOPE', 'en')).toBe(errorMessages.INTERNAL_ERROR.en);
  });
});
