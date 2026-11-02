import { stripSeparators, toAsciiDigits } from './digits';

export type NidKind = 'SMART_10' | 'OLD_13' | 'OLD_17';

export interface NormalizedNid {
  /** Digits exactly as given (ASCII, separators removed). */
  digits: string;
  kind: NidKind;
  /**
   * Identity key used for matching the same person across formats.
   * A 17-digit NID is the 4-digit birth year followed by the 13-digit number,
   * so 13- and 17-digit forms of the same NID share one key.
   * 10-digit smart-card numbers cannot be derived from the old number and keep their own key
   * (linking needs EC verification or manual officer linking).
   */
  canonical: string;
  /** Birth year embedded in a 17-digit NID, if any. */
  embeddedBirthYear?: number;
}

export type NidError = 'NID_INVALID_FORMAT' | 'NID_BIRTH_YEAR_MISMATCH';

export function normalizeNid(
  input: string,
  dateOfBirth?: string,
): { ok: true; value: NormalizedNid } | { ok: false; error: NidError } {
  if (typeof input !== 'string') return { ok: false, error: 'NID_INVALID_FORMAT' };
  const digits = stripSeparators(toAsciiDigits(input.trim()));
  if (!/^\d+$/.test(digits)) return { ok: false, error: 'NID_INVALID_FORMAT' };
  if (/^0+$/.test(digits)) return { ok: false, error: 'NID_INVALID_FORMAT' };

  if (digits.length === 10) {
    return { ok: true, value: { digits, kind: 'SMART_10', canonical: `S10:${digits}` } };
  }
  if (digits.length === 13) {
    return { ok: true, value: { digits, kind: 'OLD_13', canonical: `N13:${digits}` } };
  }
  if (digits.length === 17) {
    const year = Number(digits.slice(0, 4));
    const nowYear = new Date().getUTCFullYear();
    if (year < 1900 || year > nowYear) return { ok: false, error: 'NID_INVALID_FORMAT' };
    if (dateOfBirth) {
      const dobYear = Number(dateOfBirth.slice(0, 4));
      if (Number.isFinite(dobYear) && dobYear !== year) {
        return { ok: false, error: 'NID_BIRTH_YEAR_MISMATCH' };
      }
    }
    return {
      ok: true,
      value: { digits, kind: 'OLD_17', canonical: `N13:${digits.slice(4)}`, embeddedBirthYear: year },
    };
  }
  return { ok: false, error: 'NID_INVALID_FORMAT' };
}

/** Mask an NID for display: ••••••3456 */
export function maskNid(digitsOrLast4: string): string {
  const last4 = digitsOrLast4.slice(-4);
  return `••••••${last4}`;
}
