/**
 * Reference data for Phase 1. Everything marked "proposed" or "sample" must be replaced by values
 * DSCC confirms in writing (zone colours/boundaries, ward→zone mapping, approved models, holidays).
 */

export const CITY = { code: 'DSCC', nameBn: 'ঢাকা দক্ষিণ সিটি কর্পোরেশন', nameEn: 'Dhaka South City Corporation', plateCityNameBn: 'ঢাকা দক্ষিণ' };

export const ZONES = [
  { code: 'Z1', nameBn: 'জোন ১ (সবুজ)', nameEn: 'Zone 1 (Green)', uiColour: '#2E7D32', plateBackgroundColour: '#1B5E20', plateAreaCodeBn: 'ক' },
  { code: 'Z2', nameBn: 'জোন ২ (নীল)', nameEn: 'Zone 2 (Blue)', uiColour: '#1565C0', plateBackgroundColour: '#0D47A1', plateAreaCodeBn: 'খ' },
  { code: 'Z3', nameBn: 'জোন ৩ (হলুদ)', nameEn: 'Zone 3 (Yellow)', uiColour: '#F9A825', plateBackgroundColour: '#F9A825', plateAreaCodeBn: 'গ' },
  { code: 'Z4', nameBn: 'জোন ৪ (কমলা)', nameEn: 'Zone 4 (Orange)', uiColour: '#EF6C00', plateBackgroundColour: '#BF360C', plateAreaCodeBn: 'ঘ' },
] as const;

/** DSCC has 75 wards. Sample even split across zones until DSCC supplies the official mapping. */
export function sampleWards(): { number: number; zoneCode: string }[] {
  const out: { number: number; zoneCode: string }[] = [];
  for (let n = 1; n <= 75; n++) {
    const zoneCode = n <= 19 ? 'Z1' : n <= 38 ? 'Z2' : n <= 57 ? 'Z3' : 'Z4';
    out.push({ number: n, zoneCode });
  }
  return out;
}

export const PERMISSIONS = [
  { code: 'application.read', description: 'View submitted applications, documents and timelines (NIDs masked)' },
  { code: 'application.verify', description: 'Start verification, record checklist results, request corrections' },
  { code: 'application.decide', description: 'Approve or reject an application (step-up TOTP; not on files the officer verified)' },
  { code: 'inspection.read', description: 'View fitness inspection appointments and results' },
  { code: 'inspection.schedule', description: 'Schedule or cancel a fitness inspection appointment' },
  { code: 'inspection.record', description: 'Record a Schedule 4 fitness inspection result as inspecting officer' },
  { code: 'inspection.countersign', description: 'Countersign a passed inspection as traffic officer (Rule 4(11)) and issue the certificate' },
  { code: 'payment.read', description: 'View invoices, payments and receipts' },
  { code: 'payment.record', description: 'Record a bank/counter challan payment against an invoice' },
  { code: 'fee.read', description: 'View the Schedule 2 fee table' },
  { code: 'registration.read', description: 'View approved applications awaiting plate/QR and issued registrations' },
  { code: 'registration.issue', description: 'Issue plate number and QR credential; revoke and reissue QR (step-up TOTP)' },
  { code: 'appeal.read', description: 'View appeals against rejection' },
  { code: 'appeal.decide', description: 'Decide an appeal as the higher authority (Rule 4(7); step-up TOTP)' },
  { code: 'zone.read', description: 'View zone configuration and history' },
  { code: 'zone.manage', description: 'Change zone names, colours, plate area codes, quotas and approval status' },
] as const;

export const ROLES: { code: string; nameBn: string; nameEn: string; permissions: string[] }[] = [
  {
    code: 'INTAKE_OFFICER',
    nameBn: 'ইনটেক কর্মকর্তা',
    nameEn: 'Intake officer',
    permissions: ['application.read', 'application.verify', 'inspection.read', 'inspection.schedule', 'payment.read', 'zone.read'],
  },
  {
    code: 'VERIFICATION_OFFICER',
    nameBn: 'যাচাই কর্মকর্তা',
    nameEn: 'Verification officer',
    permissions: ['application.read', 'application.verify', 'inspection.read', 'inspection.schedule', 'payment.read', 'zone.read'],
  },
  {
    code: 'APPROVING_OFFICER',
    nameBn: 'অনুমোদন কর্মকর্তা',
    nameEn: 'Approving officer',
    permissions: ['application.read', 'application.decide', 'inspection.read', 'payment.read', 'registration.read', 'zone.read'],
  },
  { code: 'INSPECTION_OFFICER', nameBn: 'ফিটনেস পরিদর্শন কর্মকর্তা', nameEn: 'Fitness inspection officer', permissions: ['inspection.read', 'inspection.record', 'zone.read'] },
  {
    code: 'TRAFFIC_COUNTERSIGNER',
    nameBn: 'ট্রাফিক প্রতিস্বাক্ষরকারী কর্মকর্তা',
    nameEn: 'Traffic countersigning officer',
    permissions: ['inspection.read', 'inspection.countersign', 'zone.read'],
  },
  { code: 'REVENUE_OFFICER', nameBn: 'রাজস্ব কর্মকর্তা', nameEn: 'Revenue officer', permissions: ['payment.read', 'payment.record', 'fee.read', 'zone.read'] },
  {
    code: 'PLATE_OFFICER',
    nameBn: 'প্লেট ও QR কর্মকর্তা',
    nameEn: 'Plate and QR officer',
    permissions: ['application.read', 'registration.read', 'registration.issue', 'zone.read'],
  },
  {
    code: 'APPEAL_AUTHORITY',
    // Rule 4(7) appeal authority: DSCC itself (confirmed by Ripon, 2026-11-02).
    nameBn: 'আপিল কর্তৃপক্ষ (ঢাকা দক্ষিণ সিটি কর্পোরেশন)',
    nameEn: 'Appeal authority (Dhaka South City Corporation)',
    permissions: ['application.read', 'appeal.read', 'appeal.decide', 'zone.read'],
  },
  {
    code: 'DSCC_ADMIN',
    nameBn: 'DSCC অ্যাডমিন',
    nameEn: 'DSCC administrator',
    permissions: ['application.read', 'inspection.read', 'payment.read', 'fee.read', 'registration.read', 'appeal.read', 'zone.read', 'zone.manage'],
  },
  { code: 'UCAR_OPERATOR', nameBn: 'UCAR টেকনিক্যাল অপারেটর', nameEn: 'UCAR technical operator', permissions: ['zone.read'] },
];

/** Schedule 2 of S.R.O. 384-Law/2026 (in force from the gazette date). Plate, QR and blue book are free. */
export const FEE_SCHEDULE_2026 = [
  { service: 'REGISTRATION', seatType: 'TWO_SEAT', amountBdt: 8000 },
  { service: 'REGISTRATION', seatType: 'FOUR_SEAT', amountBdt: 10000 },
  { service: 'RENEWAL', seatType: 'TWO_SEAT', amountBdt: 4000 },
  { service: 'RENEWAL', seatType: 'FOUR_SEAT', amountBdt: 5000 },
  { service: 'FITNESS', seatType: null, amountBdt: 1000 },
].map((f) => ({ ...f, effectiveFrom: '2026-10-29', legalRef: 'এস.আর.ও. নং ৩৮৪-আইন/২০২৬, তফসিল-২' }));

export const SAMPLE_MODELS = [
  { manufacturer: { nameBn: 'নমুনা প্রস্তুতকারক ক', nameEn: 'Sample Manufacturer A' }, models: [{ name: 'EA-200 (২ আসন)', seatType: 'TWO_SEAT' }, { name: 'EA-400 (৪ আসন)', seatType: 'FOUR_SEAT' }] },
  { manufacturer: { nameBn: 'নমুনা প্রস্তুতকারক খ', nameEn: 'Sample Manufacturer B' }, models: [{ name: 'EB-2 (২ আসন)', seatType: 'TWO_SEAT' }, { name: 'EB-4 (৪ আসন)', seatType: 'FOUR_SEAT' }] },
] as const;

/** Fixed-date public holidays only; lunar holidays (Eid, Puja etc.) must come from the official government calendar. */
export const SAMPLE_HOLIDAYS = [2026, 2027].flatMap((y) => [
  { date: `${y}-02-21`, nameBn: 'শহীদ দিবস ও আন্তর্জাতিক মাতৃভাষা দিবস' },
  { date: `${y}-03-26`, nameBn: 'স্বাধীনতা ও জাতীয় দিবস' },
  { date: `${y}-04-14`, nameBn: 'বাংলা নববর্ষ' },
  { date: `${y}-05-01`, nameBn: 'মে দিবস' },
  { date: `${y}-12-16`, nameBn: 'বিজয় দিবস' },
  { date: `${y}-12-25`, nameBn: 'যিশুখ্রিস্টের জন্মদিন (বড়দিন)' },
]);
