import { toBengaliDigits } from './digits';

/**
 * Application number: <CITY>-<YEAR>-<6-digit sequence>, e.g. DSCC-2026-000125.
 * Sequence is per city per year and only allocated on successful submission.
 */
export function formatApplicationNumber(cityCode: string, year: number, seq: number): string {
  if (!/^[A-Z]{2,8}$/.test(cityCode)) throw new Error('invalid city code');
  if (!Number.isInteger(year) || year < 2000 || year > 9999) throw new Error('invalid year');
  if (!Number.isInteger(seq) || seq < 1 || seq > 999_999) throw new Error('application sequence out of range');
  return `${cityCode}-${year}-${String(seq).padStart(6, '0')}`;
}

const APP_NO_RE = /^([A-Z]{2,8})-(\d{4})-(\d{6})$/;

export function parseApplicationNumber(value: string): { cityCode: string; year: number; seq: number } | null {
  const m = APP_NO_RE.exec(value.trim().toUpperCase());
  if (!m) return null;
  const seq = Number(m[3]);
  if (seq < 1) return null;
  return { cityCode: m[1], year: Number(m[2]), seq };
}

/**
 * Machine-readable plate/system ID: <CITY>-<ZONE>-<4-digit serial>, e.g. DSCC-Z1-2324.
 * Proposed format, subject to DSCC approval.
 */
export function formatPlateSystemId(cityCode: string, zoneCode: string, serial: number): string {
  if (!/^[A-Z]{2,8}$/.test(cityCode)) throw new Error('invalid city code');
  if (!/^Z\d{1,2}$/.test(zoneCode)) throw new Error('invalid zone code');
  if (!Number.isInteger(serial) || serial < 1 || serial > 9999) throw new Error('plate serial out of range');
  return `${cityCode}-${zoneCode}-${String(serial).padStart(4, '0')}`;
}

export function parsePlateSystemId(value: string): { cityCode: string; zoneCode: string; serial: number } | null {
  const m = /^([A-Z]{2,8})-(Z\d{1,2})-(\d{4})$/.exec(value.trim().toUpperCase());
  if (!m) return null;
  const serial = Number(m[3]);
  if (serial < 1) return null;
  return { cityCode: m[1], zoneCode: m[2], serial };
}

/**
 * Printed Bengali plate text following Schedule 3 of the 2026 rules:
 * "[city name] [area code]-[number]", e.g. "ঢাকা দক্ষিণ-ক-২৩২৪".
 */
export function formatPlateBengali(cityNameBn: string, areaCodeBn: string, serial: number): string {
  if (!cityNameBn.trim() || !areaCodeBn.trim()) throw new Error('city name and area code are required');
  if (!Number.isInteger(serial) || serial < 1 || serial > 9999) throw new Error('plate serial out of range');
  return `${cityNameBn.trim()}-${areaCodeBn.trim()}-${toBengaliDigits(String(serial).padStart(4, '0'))}`;
}
