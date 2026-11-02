import { describe, expect, it } from 'vitest';
import {
  FITNESS_ITEMS,
  QUOTA_HOLDING_APPLICATION_STATUSES,
  VERIFICATION_ITEMS,
  addMonthsIso,
  appealSchema,
  applicationFeeLines,
  checklistComplete,
  correctionRequestSchema,
  feeFor,
  formatSerial,
  gatesSatisfied,
  inspectionPassed,
  nextStatus,
  parseQrToken,
  periodEndIso,
  qrSignedMessage,
  rejectionSchema,
  FeeScheduleRow,
} from '../src';

const SCHEDULE: FeeScheduleRow[] = [
  { id: 'r2', service: 'REGISTRATION', seatType: 'TWO_SEAT', amountBdt: 8000, effectiveFrom: '2026-10-29', effectiveTo: null, legalRef: 'তফসিল-২' },
  { id: 'r4', service: 'REGISTRATION', seatType: 'FOUR_SEAT', amountBdt: 10000, effectiveFrom: '2026-10-29', effectiveTo: null, legalRef: 'তফসিল-২' },
  { id: 'f', service: 'FITNESS', seatType: null, amountBdt: 1000, effectiveFrom: '2026-10-29', effectiveTo: null, legalRef: 'তফসিল-২' },
  { id: 'old', service: 'REGISTRATION', seatType: 'TWO_SEAT', amountBdt: 5000, effectiveFrom: '2025-01-01', effectiveTo: '2026-10-28', legalRef: '২০২৫' },
];

describe('phase 2 status transitions', () => {
  it('allows verification, correction, decision and appeal transitions only from the right states', () => {
    expect(nextStatus('SUBMITTED', 'START_VERIFICATION')).toBe('UNDER_VERIFICATION');
    expect(nextStatus('UNDER_VERIFICATION', 'REQUEST_CORRECTION')).toBe('CORRECTION_REQUESTED');
    expect(nextStatus('CORRECTION_REQUESTED', 'RESUBMIT')).toBe('SUBMITTED');
    expect(nextStatus('UNDER_VERIFICATION', 'APPROVE')).toBe('APPROVED');
    expect(nextStatus('UNDER_VERIFICATION', 'REJECT')).toBe('REJECTED');
    expect(nextStatus('SUBMITTED', 'APPROVE')).toBeNull();
    expect(nextStatus('APPROVED', 'REJECT')).toBeNull();
    expect(nextStatus('REJECTED', 'REOPEN_ON_APPEAL')).toBe('UNDER_VERIFICATION');
    expect(nextStatus('APPROVED', 'WITHDRAW')).toBeNull();
    expect(QUOTA_HOLDING_APPLICATION_STATUSES.has('REJECTED')).toBe(true);
  });
});

describe('verification checklist', () => {
  it('uses the latest result per item and requires every item to pass', () => {
    const base = VERIFICATION_ITEMS.map((item) => ({ item, result: 'PASS', at: '2026-11-02T10:00:00Z' }));
    expect(checklistComplete(base).complete).toBe(true);
    const failedLater = [...base, { item: 'CHASSIS_MOTOR', result: 'FAIL', at: '2026-11-02T11:00:00Z' }];
    expect(checklistComplete(failedLater).complete).toBe(false);
    expect(checklistComplete(failedLater).items.CHASSIS_MOTOR).toBe('FAIL');
    expect(checklistComplete(base.slice(1)).items.OWNER_IDENTITY).toBeNull();
  });
});

describe('reasons and requests', () => {
  it('requires written rejection reasons and a TOTP code', () => {
    expect(rejectionSchema.safeParse({ reasons: ['OTHER'], reasonText: 'short', totp: '123456' }).success).toBe(false);
    expect(rejectionSchema.safeParse({ reasons: [], reasonText: 'চেসিস নম্বর মিলছে না, সঠিক কাগজ দিন', totp: '123456' }).success).toBe(false);
    expect(rejectionSchema.safeParse({ reasons: ['FALSE_DECLARATION'], reasonText: 'চেসিস নম্বর মিলছে না, সঠিক কাগজ দিন', totp: '12345' }).success).toBe(false);
    const ok = rejectionSchema.parse({ reasons: ['OTHER', 'OTHER'], reasonText: 'চেসিস নম্বর মিলছে না, সঠিক কাগজ দিন', totp: '123456' });
    expect(ok.reasons).toEqual(['OTHER']);
  });
  it('accepts correction items that are form sections or document types', () => {
    expect(correctionRequestSchema.safeParse({ items: ['vehicle', 'OWNER_PHOTO'], message: 'ছবি অস্পষ্ট' }).success).toBe(true);
    expect(correctionRequestSchema.safeParse({ items: ['password'], message: 'ছবি অস্পষ্ট' }).success).toBe(false);
    expect(appealSchema.safeParse({ grounds: 'ছোট' }).success).toBe(false);
  });
});

describe('fitness inspection', () => {
  it('passes only when every Schedule 4 item passes', () => {
    const all = Object.fromEntries(FITNESS_ITEMS.map((i) => [i, 'PASS'])) as Record<(typeof FITNESS_ITEMS)[number], 'PASS' | 'FAIL'>;
    expect(inspectionPassed(all)).toBe(true);
    expect(inspectionPassed({ ...all, HORN: 'FAIL' })).toBe(false);
  });
  it('computes validity periods across month ends and leap years', () => {
    expect(addMonthsIso('2026-01-31', 1)).toBe('2026-02-28');
    expect(addMonthsIso('2028-01-31', 1)).toBe('2028-02-29');
    expect(periodEndIso('2026-11-02', 60)).toBe('2031-11-01');
    expect(periodEndIso('2026-11-02', 12)).toBe('2027-11-01');
  });
});

describe('fees (Schedule 2)', () => {
  it('picks the seat-specific fee in force on the date and falls back to an all-types row', () => {
    expect(feeFor(SCHEDULE, 'REGISTRATION', 'TWO_SEAT', '2026-11-02').amountBdt).toBe(8000);
    expect(feeFor(SCHEDULE, 'REGISTRATION', 'FOUR_SEAT', '2026-11-02').amountBdt).toBe(10000);
    expect(feeFor(SCHEDULE, 'REGISTRATION', 'TWO_SEAT', '2026-06-01').amountBdt).toBe(5000);
    expect(feeFor(SCHEDULE, 'FITNESS', 'FOUR_SEAT', '2026-11-02')).toMatchObject({ amountBdt: 1000, feeScheduleId: 'f' });
    expect(() => feeFor(SCHEDULE, 'RENEWAL', 'TWO_SEAT', '2026-11-02')).toThrow(/FEE_SCHEDULE_MISSING/);
    const lines = applicationFeeLines(SCHEDULE, 'FOUR_SEAT', '2026-11-02');
    expect(lines.reduce((n, l) => n + l.amountBdt, 0)).toBe(11000);
  });
  it('formats invoice, receipt and certificate serials', () => {
    expect(formatSerial('INV', 'DSCC', 2026, 7)).toBe('INV-DSCC-2026-000007');
    expect(() => formatSerial('INV', 'DSCC', 2026, 0)).toThrow();
  });
});

describe('approval gates', () => {
  it('lists every unmet gate', () => {
    const g = {
      STATUS_UNDER_VERIFICATION: true,
      OWNER_NID_VERIFIED: true,
      CHECKLIST_COMPLETE: false,
      NO_OPEN_CORRECTION: true,
      FITNESS_CERTIFICATE_VALID: false,
      FEES_PAID: true,
      ZONE_QUOTA_AVAILABLE: true,
      SEPARATION_OF_DUTIES: true,
    };
    expect(gatesSatisfied(g)).toEqual(['CHECKLIST_COMPLETE', 'FITNESS_CERTIFICATE_VALID']);
  });
});

describe('QR token format', () => {
  it('round-trips and rejects anything that could carry personal data or be malformed', () => {
    const id = 'AAAAAAAAAAAAAAAAAAAAAA';
    const msg = qrSignedMessage('DSCC', id, 1);
    expect(msg).toBe(`Q1.DSCC.${id}.1`);
    const sig = `${'x'.repeat(85)}w`;
    expect(parseQrToken(`${msg}.${sig}`)).toMatchObject({ cityCode: 'DSCC', tokenId: id, version: 1, message: msg });
    expect(parseQrToken(`${msg}.short`)).toBeNull();
    // Non-canonical base64url (non-zero padding bits) would decode to the same bytes, so it is refused.
    expect(parseQrToken(`${msg}.${'x'.repeat(85)}x`)).toBeNull();
    expect(parseQrToken(`${msg}.${'x'.repeat(85)}E`)).toBeNull();
    expect(parseQrToken(`Q1.DSCC.${'A'.repeat(21)}B.1.${sig}`)).toBeNull();
    expect(parseQrToken(`Q1.DSCC.01712345678.1.${sig}`)).toBeNull();
    expect(() => qrSignedMessage('DSCC', 'bad', 1)).toThrow();
  });
});
