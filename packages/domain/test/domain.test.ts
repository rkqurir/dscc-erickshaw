import { describe, expect, it } from 'vitest';
import {
  addWorkingDays,
  applicationSubmitSchema,
  contrastRatio,
  dhakaYear,
  formatApplicationNumber,
  formatPlateBengali,
  formatPlateSystemId,
  maskNid,
  maskPhone,
  nextStatus,
  normalizeBdMobile,
  normalizeNid,
  ownerIdentitySchema,
  parseApplicationNumber,
  parsePlateSystemId,
  toAsciiDigits,
  toBengaliDigits,
  whiteTextContrastOk,
  workingDaysBetween,
} from '../src';

describe('digits', () => {
  it('converts Bengali digits to ASCII and back', () => {
    expect(toAsciiDigits('০১৭১২৩৪৫৬৭৮')).toBe('01712345678');
    expect(toBengaliDigits('2324')).toBe('২৩২৪');
    expect(toBengaliDigits(2026)).toBe('২০২৬');
  });
});

describe('normalizeBdMobile', () => {
  it.each([
    ['01712345678', '+8801712345678'],
    ['+8801712345678', '+8801712345678'],
    ['8801712345678', '+8801712345678'],
    ['008801712345678', '+8801712345678'],
    ['০১৭১২-৩৪৫৬৭৮', '+8801712345678'],
    ['013 1234 5678', '+8801312345678'],
  ])('%s → %s', (input, out) => {
    expect(normalizeBdMobile(input)).toBe(out);
  });
  it.each(['01212345678', '0171234567', '017123456789', 'abc', '', '+1 415 555 0100'])('rejects %s', (input) => {
    expect(normalizeBdMobile(input)).toBeNull();
  });
  it('masks', () => {
    expect(maskPhone('+8801712345678')).toBe('+8801712••••78');
  });
});

describe('normalizeNid', () => {
  it('accepts 10, 13 and 17 digit numbers', () => {
    expect(normalizeNid('1234567890')).toMatchObject({ ok: true, value: { kind: 'SMART_10' } });
    expect(normalizeNid('1234567890123')).toMatchObject({ ok: true, value: { kind: 'OLD_13' } });
    expect(normalizeNid('19901234567890123')).toMatchObject({ ok: true, value: { kind: 'OLD_17', embeddedBirthYear: 1990 } });
  });
  it('matches the 13 and 17 digit forms of the same NID', () => {
    const a = normalizeNid('1234567890123');
    const b = normalizeNid('1990 1234567890123');
    expect(a.ok && b.ok && a.value.canonical === b.value.canonical).toBe(true);
  });
  it('normalizes Bengali digits and separators', () => {
    const r = normalizeNid('১২৩-৪৫৬-৭৮৯০');
    expect(r).toMatchObject({ ok: true, value: { digits: '1234567890' } });
  });
  it('rejects bad lengths, letters, all zeros and impossible birth years', () => {
    expect(normalizeNid('12345').ok).toBe(false);
    expect(normalizeNid('12345678901234').ok).toBe(false);
    expect(normalizeNid('12345abc90').ok).toBe(false);
    expect(normalizeNid('0000000000').ok).toBe(false);
    expect(normalizeNid('18001234567890123').ok).toBe(false);
  });
  it('rejects a 17-digit NID whose embedded year differs from the date of birth', () => {
    expect(normalizeNid('19901234567890123', '1991-05-01')).toEqual({ ok: false, error: 'NID_BIRTH_YEAR_MISMATCH' });
  });
  it('masks', () => {
    expect(maskNid('1234567890123')).toBe('••••••0123');
  });
});

describe('identifiers', () => {
  it('formats application numbers as DSCC-2026-000125', () => {
    expect(formatApplicationNumber('DSCC', 2026, 125)).toBe('DSCC-2026-000125');
    expect(parseApplicationNumber('dscc-2026-000125')).toEqual({ cityCode: 'DSCC', year: 2026, seq: 125 });
    expect(parseApplicationNumber('DSCC-2026-125')).toBeNull();
    expect(() => formatApplicationNumber('DSCC', 2026, 0)).toThrow();
    expect(() => formatApplicationNumber('DSCC', 2026, 1_000_000)).toThrow();
  });
  it('formats plate system IDs as DSCC-Z1-2324 and Bengali plates per Schedule 3', () => {
    expect(formatPlateSystemId('DSCC', 'Z1', 2324)).toBe('DSCC-Z1-2324');
    expect(formatPlateSystemId('DSCC', 'Z4', 7)).toBe('DSCC-Z4-0007');
    expect(parsePlateSystemId('DSCC-Z3-0042')).toEqual({ cityCode: 'DSCC', zoneCode: 'Z3', serial: 42 });
    expect(formatPlateBengali('ঢাকা দক্ষিণ', 'ক', 2324)).toBe('ঢাকা দক্ষিণ-ক-২৩২৪');
    expect(() => formatPlateSystemId('DSCC', 'Z1', 10_000)).toThrow();
  });
});

describe('working days', () => {
  it('skips Friday, Saturday and holidays', () => {
    // 2026-11-01 is a Sunday.
    const sun = new Date('2026-11-01T04:00:00Z');
    const nextSun = new Date('2026-11-08T04:00:00Z');
    expect(workingDaysBetween(sun, nextSun)).toBe(5); // Mon–Thu + Sun
    expect(workingDaysBetween(sun, nextSun, new Set(['2026-11-03']))).toBe(4);
    expect(addWorkingDays(sun, 5)).toBe('2026-11-08');
  });
  it('uses the Asia/Dhaka calendar year', () => {
    expect(dhakaYear(new Date('2026-12-31T19:00:00Z'))).toBe(2027);
    expect(dhakaYear(new Date('2026-12-31T17:00:00Z'))).toBe(2026);
  });
});

describe('application transitions', () => {
  it('allows only valid transitions', () => {
    expect(nextStatus('DRAFT', 'SUBMIT')).toBe('SUBMITTED');
    expect(nextStatus('SUBMITTED', 'SUBMIT')).toBeNull();
    expect(nextStatus('SUBMITTED', 'WITHDRAW')).toBe('WITHDRAWN');
    expect(nextStatus('DRAFT', 'WITHDRAW')).toBeNull();
    expect(nextStatus('WITHDRAWN', 'WITHDRAW')).toBeNull();
  });
});

describe('form schemas', () => {
  const owner = {
    nid: '1234567890',
    dateOfBirth: '1985-02-10',
    nameBn: 'রহিম উদ্দিন',
    fatherNameBn: 'করিম উদ্দিন',
    motherNameBn: 'রহিমা খাতুন',
    presentAddress: 'ঢাকা',
    permanentAddress: 'ঢাকা',
    education: 'SSC',
    declareCitizen: true,
    declareSoundMind: true,
  };
  it('accepts a valid owner and rejects minors and missing declarations', () => {
    expect(ownerIdentitySchema.safeParse(owner).success).toBe(true);
    const minor = ownerIdentitySchema.safeParse({ ...owner, dateOfBirth: `${new Date().getUTCFullYear() - 10}-01-01` });
    expect(minor.success).toBe(false);
    expect(ownerIdentitySchema.safeParse({ ...owner, declareCitizen: false }).success).toBe(false);
  });
  it('validates a full application and normalizes the driver phone', () => {
    const r = applicationSubmitSchema.safeParse({
      vehicle: {
        seatType: 'TWO_SEAT',
        modelId: '018f6b5e-0000-7000-8000-000000000001',
        manufactureYear: 2025,
        chassisNo: 'ch-12345 ',
        motorNo: 'MT9876',
        batteryType: 'LITHIUM_ION',
        hasSpeedometer: true,
      },
      location: {
        zoneId: '018f6b5e-0000-7000-8000-000000000002',
        wardId: '018f6b5e-0000-7000-8000-000000000003',
        chargingLocation: 'লালবাগ চার্জিং স্টেশন',
      },
      driver: {
        nameBn: 'চালক',
        nid: '9876543210',
        dateOfBirth: '1990-01-01',
        phone: '০১৮১২৩৪৫৬৭৮',
        address: 'ঢাকা',
      },
      declaration: { truthful: true },
    });
    expect(r.success).toBe(true);
    if (r.success) {
      expect(r.data.driver.phone).toBe('+8801812345678');
      expect(r.data.vehicle.chassisNo).toBe('CH-12345');
    }
  });
});

describe('plate colour contrast', () => {
  it('flags yellow backgrounds as unreadable with white letters', () => {
    expect(contrastRatio('#FFFFFF', '#000000')).toBeCloseTo(21, 0);
    expect(whiteTextContrastOk('#1B5E20')).toBe(true); // dark green
    expect(whiteTextContrastOk('#FBC02D')).toBe(false); // yellow
  });
});
