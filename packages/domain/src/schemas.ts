import { z } from 'zod';
import { toAsciiDigits } from './digits';
import { normalizeBdMobile } from './phone';
import { normalizeNid } from './nid';

/** Five-vehicle limit per owner NID across all city corporations (S.R.O. 384-Law/2026, Rule 4(8)). */
export const MAX_VEHICLES_PER_NID = 5;

const isoDate = z
  .string()
  .transform((s) => toAsciiDigits(s.trim()))
  .refine((s) => /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(`${s}T00:00:00Z`)), {
    message: 'DATE_INVALID',
  });

export function ageOn(dobIso: string, on: Date): number {
  const [y, m, d] = dobIso.split('-').map(Number);
  let age = on.getUTCFullYear() - y;
  const md = (on.getUTCMonth() + 1) * 100 + on.getUTCDate();
  if (md < m * 100 + d) age--;
  return age;
}

const adultDob = isoDate.refine((s) => ageOn(s, new Date()) >= 18, { message: 'AGE_UNDER_18' }).refine(
  (s) => ageOn(s, new Date()) <= 120,
  { message: 'DATE_INVALID' },
);

const text = (max: number) => z.string().trim().min(1, 'REQUIRED').max(max, 'TOO_LONG');
const optionalText = (max: number) =>
  z
    .string()
    .trim()
    .max(max, 'TOO_LONG')
    .optional()
    .transform((v) => (v ? v : undefined));

export const bdMobileSchema = z
  .string()
  .transform((s, ctx) => {
    const n = normalizeBdMobile(s);
    if (!n) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'PHONE_INVALID' });
      return z.NEVER;
    }
    return n;
  });

export const nidSchema = z.string().refine((s) => normalizeNid(s).ok, { message: 'NID_INVALID_FORMAT' });

export const EDUCATION_LEVELS = ['NONE', 'PRIMARY', 'JSC', 'SSC', 'HSC', 'GRADUATE', 'POSTGRADUATE'] as const;

export const ownerIdentitySchema = z
  .object({
    nid: nidSchema,
    dateOfBirth: adultDob,
    nameBn: text(120),
    nameEn: optionalText(120),
    fatherNameBn: text(120),
    motherNameBn: text(120),
    presentAddress: text(500),
    permanentAddress: text(500),
    education: z.enum(EDUCATION_LEVELS),
    declareCitizen: z.literal(true, { errorMap: () => ({ message: 'DECLARATION_REQUIRED' }) }),
    declareSoundMind: z.literal(true, { errorMap: () => ({ message: 'DECLARATION_REQUIRED' }) }),
  })
  .superRefine((v, ctx) => {
    const r = normalizeNid(v.nid, v.dateOfBirth);
    if (!r.ok) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['nid'], message: r.error });
  });
export type OwnerIdentityInput = z.input<typeof ownerIdentitySchema>;

export const SEAT_TYPES = ['TWO_SEAT', 'FOUR_SEAT'] as const;
export const BATTERY_TYPES = ['LEAD_ACID', 'LITHIUM_ION', 'LIFEPO4', 'OTHER'] as const;

const chassisLike = z
  .string()
  .transform((s) => toAsciiDigits(s).toUpperCase().replace(/\s+/g, ''))
  .refine((s) => /^[A-Z0-9\-/]{5,30}$/.test(s), { message: 'SERIAL_INVALID' });

export const vehicleSectionSchema = z.object({
  seatType: z.enum(SEAT_TYPES),
  modelId: z.string().uuid('REQUIRED'),
  manufactureYear: z.coerce
    .number()
    .int()
    .min(2000, 'YEAR_INVALID')
    .refine((y) => y <= new Date().getUTCFullYear(), { message: 'YEAR_INVALID' }),
  chassisNo: chassisLike,
  motorNo: chassisLike,
  batteryType: z.enum(BATTERY_TYPES),
  hasSpeedometer: z.boolean(),
  insurancePolicyNo: optionalText(60),
  colour: optionalText(40),
});

export const locationSectionSchema = z.object({
  zoneId: z.string().uuid('REQUIRED'),
  wardId: z.string().uuid('REQUIRED'),
  chargingLocation: text(300),
});

export const driverSectionSchema = z
  .object({
    nameBn: text(120),
    nameEn: optionalText(120),
    nid: nidSchema,
    dateOfBirth: adultDob,
    phone: bdMobileSchema,
    address: text(500),
    trainingCertificateNo: optionalText(60),
  })
  .superRefine((v, ctx) => {
    const r = normalizeNid(v.nid, v.dateOfBirth);
    if (!r.ok) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['nid'], message: r.error });
  });

export const declarationSectionSchema = z.object({
  truthful: z.literal(true, { errorMap: () => ({ message: 'DECLARATION_REQUIRED' }) }),
});

export const applicationSubmitSchema = z.object({
  vehicle: vehicleSectionSchema,
  location: locationSectionSchema,
  driver: driverSectionSchema,
  declaration: declarationSectionSchema,
});
export type ApplicationForm = z.output<typeof applicationSubmitSchema>;

/**
 * Draft autosave accepts any partial, size-bounded object with the known sections; full validation
 * runs on submit.
 */
export const applicationDraftSchema = z
  .object({
    vehicle: z.record(z.unknown()).optional(),
    location: z.record(z.unknown()).optional(),
    driver: z.record(z.unknown()).optional(),
    declaration: z.record(z.unknown()).optional(),
  })
  .strict()
  .refine((v) => JSON.stringify(v).length <= 20_000, { message: 'TOO_LONG' });
export type ApplicationDraft = z.infer<typeof applicationDraftSchema>;

export const DOCUMENT_TYPES = {
  OWNER_NID_COPY: { required: true },
  OWNER_PHOTO: { required: true },
  VEHICLE_PHOTO_FRONT: { required: true },
  VEHICLE_PHOTO_BACK: { required: true },
  VEHICLE_PHOTO_LEFT: { required: true },
  VEHICLE_PHOTO_RIGHT: { required: true },
  // The certificate is issued in the system before submission (DSCC decision, 2026-11-02); an uploaded copy is optional.
  FITNESS_CERTIFICATE: { required: false },
  FEE_RECEIPT: { required: true },
  DRIVER_PHOTO: { required: true },
  DRIVER_NID_COPY: { required: true },
  INSURANCE_DOCUMENT: { required: false },
  DRIVER_TRAINING_CERTIFICATE: { required: false },
} as const;
export type DocumentType = keyof typeof DOCUMENT_TYPES;
export const DOCUMENT_TYPE_LIST = Object.keys(DOCUMENT_TYPES) as DocumentType[];
export const REQUIRED_DOCUMENT_TYPES = DOCUMENT_TYPE_LIST.filter((t) => DOCUMENT_TYPES[t].required);

export const ALLOWED_UPLOAD_MIME = ['image/jpeg', 'image/png', 'application/pdf'] as const;
export const MAX_UPLOAD_BYTES = 5 * 1024 * 1024;

export const zoneUpdateSchema = z.object({
  nameBn: text(60),
  nameEn: text(60),
  uiColour: z.string().regex(/^#[0-9A-Fa-f]{6}$/, 'COLOUR_INVALID'),
  plateBackgroundColour: z.string().regex(/^#[0-9A-Fa-f]{6}$/, 'COLOUR_INVALID'),
  plateAreaCodeBn: z.string().trim().min(1, 'REQUIRED').max(4, 'TOO_LONG'),
  vehicleQuota: z.coerce.number().int().min(0).max(100_000).nullable(),
  approvalStatus: z.enum(['DRAFT', 'PROPOSED', 'APPROVED']),
  changeNote: text(300),
});
export type ZoneUpdateInput = z.input<typeof zoneUpdateSchema>;
