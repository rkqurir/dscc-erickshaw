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
  { code: 'zone.read', description: 'View zone configuration and history' },
  { code: 'zone.manage', description: 'Change zone names, colours, plate area codes, quotas and approval status' },
] as const;

export const ROLES: { code: string; nameBn: string; nameEn: string; permissions: string[] }[] = [
  { code: 'INTAKE_OFFICER', nameBn: 'ইনটেক কর্মকর্তা', nameEn: 'Intake officer', permissions: ['application.read', 'zone.read'] },
  { code: 'VERIFICATION_OFFICER', nameBn: 'যাচাই কর্মকর্তা', nameEn: 'Verification officer', permissions: ['application.read', 'zone.read'] },
  { code: 'APPROVING_OFFICER', nameBn: 'অনুমোদন কর্মকর্তা', nameEn: 'Approving officer', permissions: ['application.read', 'zone.read'] },
  { code: 'DSCC_ADMIN', nameBn: 'DSCC অ্যাডমিন', nameEn: 'DSCC administrator', permissions: ['application.read', 'zone.read', 'zone.manage'] },
  { code: 'UCAR_OPERATOR', nameBn: 'UCAR টেকনিক্যাল অপারেটর', nameEn: 'UCAR technical operator', permissions: ['zone.read'] },
];

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
