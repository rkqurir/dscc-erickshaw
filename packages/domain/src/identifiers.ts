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
 * Machine-readable plate/system ID: <CITY>-<ZONE>-<6-digit serial>, e.g. DSCC-Z1-000001
 * (format confirmed by DSCC, 2026-11-02).
 * Proposed format, subject to DSCC approval.
 */
/** Plate serials are six digits per zone: 000001–999999. */
export const PLATE_SERIAL_DIGITS = 6;
export const PLATE_SERIAL_MAX = 999_999;

export function formatPlateSystemId(cityCode: string, zoneCode: string, serial: number): string {
  if (!/^[A-Z]{2,8}$/.test(cityCode)) throw new Error('invalid city code');
  if (!/^Z\d{1,2}$/.test(zoneCode)) throw new Error('invalid zone code');
  if (!Number.isInteger(serial) || serial < 1 || serial > PLATE_SERIAL_MAX) throw new Error('plate serial out of range');
  return `${cityCode}-${zoneCode}-${String(serial).padStart(PLATE_SERIAL_DIGITS, '0')}`;
}

export function parsePlateSystemId(value: string): { cityCode: string; zoneCode: string; serial: number } | null {
  const m = /^([A-Z]{2,8})-(Z\d{1,2})-(\d{6})$/.exec(value.trim().toUpperCase());
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
  if (!Number.isInteger(serial) || serial < 1 || serial > PLATE_SERIAL_MAX) throw new Error('plate serial out of range');
  return `${cityNameBn.trim()}-${areaCodeBn.trim()}-${toBengaliDigits(String(serial).padStart(PLATE_SERIAL_DIGITS, '0'))}`;
}

/**
 * QR credential token: Q1.<CITY>.<random id>.<version>.<Ed25519 signature>, all base64url-safe.
 * The signed message is everything before the last dot. It carries no NID, phone or plate number;
 * the random id is looked up server-side, and the signature lets an offline reader detect forgeries.
 */
export const QR_TOKEN_VERSION = 'Q1';

export function qrSignedMessage(cityCode: string, tokenId: string, version: number): string {
  if (!/^[A-Z]{2,8}$/.test(cityCode)) throw new Error('invalid city code');
  if (!/^[A-Za-z0-9_-]{22}$/.test(tokenId)) throw new Error('invalid token id');
  if (!Number.isInteger(version) || version < 1 || version > 999) throw new Error('invalid version');
  return `${QR_TOKEN_VERSION}.${cityCode}.${tokenId}.${version}`;
}

export function parseQrToken(token: string): { cityCode: string; tokenId: string; version: number; message: string; signature: string } | null {
  if (typeof token !== 'string' || token.length > 200) return null;
  // Base64url must be canonical: the 4 unused low bits of the last character are zero (16-byte id → 22
  // characters, 64-byte signature → 86 characters, both 4 padding bits). Otherwise several strings would
  // decode to the same bytes and verify.
  const m = /^(Q1)\.([A-Z]{2,8})\.([A-Za-z0-9_-]{21}[AQgw])\.([1-9]\d{0,2})\.([A-Za-z0-9_-]{85}[AQgw])$/.exec(token);
  if (!m) return null;
  return { cityCode: m[2], tokenId: m[3], version: Number(m[4]), message: `${m[1]}.${m[2]}.${m[3]}.${m[4]}`, signature: m[5] };
}
