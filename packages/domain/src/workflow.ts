/**
 * Phase 2 workflow vocabulary: verification checklist, correction items, rejection reasons,
 * fitness inspection items, fees and approval gates. Codes are stable identifiers stored in the
 * database; their Bengali/English labels live in @dscc/localization.
 */
import { z } from 'zod';
import { DOCUMENT_TYPE_LIST, DocumentType } from './schemas';

// ─── Verification checklist (officer review of the submitted file) ───
export const VERIFICATION_ITEMS = [
  'OWNER_IDENTITY', // NID copy, name, date of birth and photo match the owner record
  'OWNER_ELIGIBILITY', // Rule 4(1): citizen, 18+, declaration
  'VEHICLE_PHOTOS', // four sides, matches the declared model
  'CHASSIS_MOTOR', // chassis and motor numbers match the vehicle
  'DRIVER_DOCUMENTS', // driver NID copy and photo
  'ZONE_WARD', // requested zone/ward and charging location are plausible
] as const;
export type VerificationItem = (typeof VERIFICATION_ITEMS)[number];

export const verificationCheckSchema = z.object({
  item: z.enum(VERIFICATION_ITEMS),
  result: z.enum(['PASS', 'FAIL']),
  note: z.string().trim().max(500, 'TOO_LONG').optional(),
});

/** Latest result per item wins; the checklist is complete only when every item's latest result is PASS. */
export function checklistComplete(checks: { item: string; result: string; at: Date | string }[]): {
  complete: boolean;
  items: Record<VerificationItem, 'PASS' | 'FAIL' | null>;
} {
  const latest = new Map<string, { result: string; at: number }>();
  for (const c of checks) {
    const at = new Date(c.at).getTime();
    const prev = latest.get(c.item);
    if (!prev || at >= prev.at) latest.set(c.item, { result: c.result, at });
  }
  const items = Object.fromEntries(
    VERIFICATION_ITEMS.map((i) => [i, (latest.get(i)?.result as 'PASS' | 'FAIL' | undefined) ?? null]),
  ) as Record<VerificationItem, 'PASS' | 'FAIL' | null>;
  return { complete: VERIFICATION_ITEMS.every((i) => items[i] === 'PASS'), items };
}

// ─── Correction requests ───
export const CORRECTION_SECTIONS = ['vehicle', 'location', 'driver'] as const;
export type CorrectionTarget = (typeof CORRECTION_SECTIONS)[number] | DocumentType;
export const CORRECTION_TARGETS: readonly string[] = [...CORRECTION_SECTIONS, ...DOCUMENT_TYPE_LIST];

export const correctionRequestSchema = z.object({
  items: z
    .array(z.string().refine((s) => CORRECTION_TARGETS.includes(s), { message: 'INVALID' }))
    .min(1, 'REQUIRED')
    .max(20)
    .transform((a) => [...new Set(a)]),
  message: z.string().trim().min(5, 'REQUIRED').max(1000, 'TOO_LONG'),
});

// ─── Rejection (Rule 4(6): reasons in writing) ───
export const REJECTION_REASONS = [
  'OWNER_INELIGIBLE',
  'NID_NOT_VERIFIED',
  'DOCUMENTS_INVALID',
  'FALSE_DECLARATION',
  'VEHICLE_NOT_APPROVED_MODEL',
  'FITNESS_FAILED',
  'ZONE_QUOTA_FULL',
  'DUPLICATE_VEHICLE',
  'OTHER',
] as const;
export type RejectionReason = (typeof REJECTION_REASONS)[number];

const totpCode = z.string().regex(/^\d{6}$/, 'MFA_INVALID');

export const rejectionSchema = z.object({
  reasons: z.array(z.enum(REJECTION_REASONS)).min(1, 'REQUIRED').max(REJECTION_REASONS.length).transform((a) => [...new Set(a)]),
  // A written explanation is always required; it is sent to the applicant verbatim.
  reasonText: z.string().trim().min(10, 'REASON_TOO_SHORT').max(2000, 'TOO_LONG'),
  totp: totpCode,
});

export const approvalSchema = z.object({
  note: z.string().trim().max(1000, 'TOO_LONG').optional(),
  totp: totpCode,
});

export const appealSchema = z.object({
  grounds: z.string().trim().min(20, 'REASON_TOO_SHORT').max(3000, 'TOO_LONG'),
});

export const appealDecisionSchema = z.object({
  outcome: z.enum(['ALLOWED', 'DISMISSED']),
  note: z.string().trim().min(10, 'REASON_TOO_SHORT').max(2000, 'TOO_LONG'),
  totp: totpCode,
});

// ─── Fitness inspection (Schedule 4; speedometer from Rule 5(3)) ───
export const FITNESS_ITEMS = ['BRAKES', 'LIGHTING', 'HORN', 'SPEED_GOVERNOR', 'CHASSIS_BODY', 'SPEEDOMETER'] as const;
export type FitnessItem = (typeof FITNESS_ITEMS)[number];

export const inspectionScheduleSchema = z.object({
  scheduledFor: z
    .string()
    .refine((s) => !Number.isNaN(Date.parse(s)), { message: 'DATE_INVALID' })
    .transform((s) => new Date(s)),
  location: z.string().trim().min(3, 'REQUIRED').max(300, 'TOO_LONG'),
});

export const inspectionResultSchema = z.object({
  checklist: z.object(
    Object.fromEntries(FITNESS_ITEMS.map((i) => [i, z.enum(['PASS', 'FAIL'])])) as Record<FitnessItem, z.ZodEnum<['PASS', 'FAIL']>>,
  ),
  note: z.string().trim().max(1000, 'TOO_LONG').optional(),
});

/** An inspection passes only if every Schedule 4 item passes. */
export function inspectionPassed(checklist: Record<FitnessItem, 'PASS' | 'FAIL'>): boolean {
  return FITNESS_ITEMS.every((i) => checklist[i] === 'PASS');
}

/**
 * The gazette leaves fitness validity blank ("valid until …"), so it is a policy value.
 * DSCC confirmed one year (Ripon, 2026-11-02).
 */
export const DEFAULT_FITNESS_VALIDITY_MONTHS = 12;

export function addMonthsIso(iso: string, months: number): string {
  const [y, m, d] = iso.split('-').map(Number);
  const total = y * 12 + (m - 1) + months;
  const ny = Math.floor(total / 12);
  const nm = (total % 12) + 1;
  const lastDay = new Date(Date.UTC(ny, nm, 0)).getUTCDate();
  return `${ny}-${String(nm).padStart(2, '0')}-${String(Math.min(d, lastDay)).padStart(2, '0')}`;
}

/** Last valid day for a period starting on `iso` (e.g. 5 years from 2026-11-02 → 2031-11-01). */
export function periodEndIso(iso: string, months: number): string {
  const end = addMonthsIso(iso, months);
  const t = Date.parse(`${end}T00:00:00Z`) - 86_400_000;
  return new Date(t).toISOString().slice(0, 10);
}

/** Rule 4(5): registration valid for 5 years. */
export const REGISTRATION_VALIDITY_MONTHS = 60;
/** Rule 5(2): economic life 12 years from registration. */
export const ECONOMIC_LIFE_MONTHS = 144;

// ─── Fees (Schedule 2) ───
export const FEE_SERVICES = ['REGISTRATION', 'RENEWAL', 'FITNESS'] as const;
export type FeeService = (typeof FEE_SERVICES)[number];

export interface FeeScheduleRow {
  id: string;
  service: string;
  seatType: string | null;
  amountBdt: number;
  effectiveFrom: string; // YYYY-MM-DD
  effectiveTo: string | null;
  legalRef: string;
}

export interface FeeLine {
  service: FeeService;
  seatType: string | null;
  amountBdt: number;
  feeScheduleId: string;
  legalRef: string;
}

/** Pick the schedule row in force on `onDate` for a service and seat type (seat-specific rows win). */
export function feeFor(rows: FeeScheduleRow[], service: FeeService, seatType: string, onDate: string): FeeLine {
  const inForce = rows.filter(
    (r) => r.service === service && r.effectiveFrom <= onDate && (r.effectiveTo === null || r.effectiveTo >= onDate),
  );
  const pick = inForce.find((r) => r.seatType === seatType) ?? inForce.find((r) => r.seatType === null);
  if (!pick) throw new Error(`FEE_SCHEDULE_MISSING:${service}:${seatType}`);
  return { service, seatType: pick.seatType, amountBdt: pick.amountBdt, feeScheduleId: pick.id, legalRef: pick.legalRef };
}

/** A new registration application pays the registration fee for its seat type and the fitness fee. */
export function applicationFeeLines(rows: FeeScheduleRow[], seatType: string, onDate: string): FeeLine[] {
  return [feeFor(rows, 'REGISTRATION', seatType, onDate), feeFor(rows, 'FITNESS', seatType, onDate)];
}

export const counterPaymentSchema = z.object({
  challanNo: z
    .string()
    .trim()
    .transform((s) => s.toUpperCase())
    .refine((s) => /^[A-Z0-9\-/]{4,40}$/.test(s), { message: 'SERIAL_INVALID' }),
  amountBdt: z.coerce.number().int().positive(),
  paidOn: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'DATE_INVALID'),
  bankName: z.string().trim().min(2, 'REQUIRED').max(100, 'TOO_LONG'),
});

// ─── Approval gates ───
export const APPROVAL_GATES = [
  'STATUS_UNDER_VERIFICATION',
  'OWNER_NID_VERIFIED',
  'CHECKLIST_COMPLETE',
  'NO_OPEN_CORRECTION',
  'FITNESS_CERTIFICATE_VALID',
  'FEES_PAID',
  'ZONE_QUOTA_AVAILABLE',
  'SEPARATION_OF_DUTIES',
] as const;
export type ApprovalGate = (typeof APPROVAL_GATES)[number];

export function gatesSatisfied(g: Record<ApprovalGate, boolean>): ApprovalGate[] {
  return APPROVAL_GATES.filter((k) => !g[k]);
}

// ─── Receipts, invoices and certificates ───
export function formatSerial(prefix: string, cityCode: string, year: number, seq: number, width = 6): string {
  if (!/^[A-Z]{2,4}$/.test(prefix)) throw new Error('invalid prefix');
  if (!/^[A-Z]{2,8}$/.test(cityCode)) throw new Error('invalid city code');
  if (!Number.isInteger(seq) || seq < 1 || seq >= 10 ** width) throw new Error('serial out of range');
  return `${prefix}-${cityCode}-${year}-${String(seq).padStart(width, '0')}`;
}
