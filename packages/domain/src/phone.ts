import { stripSeparators, toAsciiDigits } from './digits';

/**
 * Bangladesh mobile numbers: 01[3-9] followed by 8 digits (11 digits national format).
 * Accepts 01XXXXXXXXX, 8801XXXXXXXXX, +8801XXXXXXXXX, 008801XXXXXXXXX and Bengali digits.
 * Returns E.164 (+8801XXXXXXXXX) or null when the input is not a valid BD mobile number.
 */
export function normalizeBdMobile(input: string): string | null {
  if (typeof input !== 'string') return null;
  let s = stripSeparators(toAsciiDigits(input.trim()));
  if (s.startsWith('+')) s = s.slice(1);
  if (s.startsWith('00')) s = s.slice(2);
  if (s.startsWith('880')) s = s.slice(2); // keep the leading 0 of the national number
  if (!/^01[3-9]\d{8}$/.test(s)) return null;
  return `+88${s}`;
}

/** Mask a normalized phone for display/logging: +8801712••••78 */
export function maskPhone(e164: string): string {
  if (e164.length < 8) return '••••';
  return `${e164.slice(0, 8)}••••${e164.slice(-2)}`;
}
