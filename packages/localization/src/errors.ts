/** API error codes with Bengali (primary) and English messages. */
export const errorMessages = {
  VALIDATION_FAILED: { bn: 'তথ্য সঠিক নয়। চিহ্নিত ঘরগুলো ঠিক করুন।', en: 'Some fields are invalid. Please correct the highlighted fields.' },
  UNAUTHENTICATED: { bn: 'অনুগ্রহ করে আবার লগইন করুন।', en: 'Please sign in again.' },
  FORBIDDEN: { bn: 'এই কাজের অনুমতি আপনার নেই।', en: 'You do not have permission to do this.' },
  NOT_FOUND: { bn: 'তথ্য পাওয়া যায়নি।', en: 'Not found.' },
  CSRF_HEADER_MISSING: { bn: 'অনুরোধটি গ্রহণযোগ্য নয়। পাতা রিফ্রেশ করে আবার চেষ্টা করুন।', en: 'Request rejected. Refresh the page and try again.' },
  RATE_LIMITED: { bn: 'অনেকবার চেষ্টা করা হয়েছে। কিছুক্ষণ পরে আবার চেষ্টা করুন।', en: 'Too many attempts. Please try again later.' },
  INTERNAL_ERROR: { bn: 'একটি সমস্যা হয়েছে। কিছুক্ষণ পরে আবার চেষ্টা করুন।', en: 'Something went wrong. Please try again later.' },
  SERVICE_BUSY: { bn: 'সার্ভার এখন ব্যস্ত। কয়েক সেকেন্ড পরে আবার চেষ্টা করুন।', en: 'The server is busy. Please try again in a few seconds.' },
  CONFLICT: { bn: 'তথ্যটি অন্য কোথাও পরিবর্তন হয়েছে। পাতা রিফ্রেশ করুন।', en: 'This record was changed elsewhere. Refresh the page.' },
  IDEMPOTENCY_KEY_REUSED: { bn: 'একই অনুরোধ-চাবি ভিন্ন তথ্যে ব্যবহার করা হয়েছে।', en: 'Idempotency key reused with different data.' },

  PHONE_INVALID: { bn: 'সঠিক বাংলাদেশি মোবাইল নম্বর দিন (যেমন ০১৭XXXXXXXX)।', en: 'Enter a valid Bangladeshi mobile number (e.g. 017XXXXXXXX).' },
  OTP_INVALID: { bn: 'OTP সঠিক নয় অথবা মেয়াদ শেষ। নতুন OTP নিন।', en: 'The OTP is incorrect or has expired. Request a new one.' },
  OTP_RESEND_COOLDOWN: { bn: 'নতুন OTP পেতে অনুগ্রহ করে এক মিনিট অপেক্ষা করুন।', en: 'Please wait a minute before requesting another OTP.' },
  CONSENT_REQUIRED: { bn: 'চালিয়ে যেতে গোপনীয়তা নোটিশে সম্মতি দিন।', en: 'Please accept the privacy notice to continue.' },

  STAFF_LOGIN_FAILED: { bn: 'ইমেইল বা পাসওয়ার্ড সঠিক নয়।', en: 'Incorrect email or password.' },
  STAFF_LOCKED: { bn: 'অনেকবার ভুল চেষ্টার কারণে অ্যাকাউন্ট সাময়িকভাবে বন্ধ। ১৫ মিনিট পরে চেষ্টা করুন।', en: 'Account temporarily locked after repeated failures. Try again in 15 minutes.' },
  MFA_REQUIRED: { bn: 'দ্বি-স্তর যাচাই (TOTP) সম্পন্ন করুন।', en: 'Complete two-factor verification (TOTP).' },
  MFA_INVALID: { bn: 'যাচাই কোড সঠিক নয়।', en: 'The verification code is incorrect.' },
  MFA_ALREADY_ENROLLED: { bn: 'দ্বি-স্তর যাচাই আগেই চালু আছে।', en: 'Two-factor verification is already set up.' },

  NID_INVALID_FORMAT: { bn: 'জাতীয় পরিচয়পত্র নম্বর ১০, ১৩ বা ১৭ অঙ্কের হতে হবে।', en: 'NID number must have 10, 13 or 17 digits.' },
  NID_BIRTH_YEAR_MISMATCH: { bn: '১৭ অঙ্কের NID-এর প্রথম চার অঙ্ক জন্মসালের সাথে মিলছে না।', en: 'The first four digits of a 17-digit NID must match the birth year.' },
  NID_DETAILS_MISMATCH: { bn: 'এই NID-এর সাথে দেওয়া জন্ম তারিখ মিলছে না।', en: 'The date of birth does not match this NID.' },
  NID_VERIFICATION_FAILED: { bn: 'NID যাচাই সফল হয়নি। তথ্য মিলিয়ে আবার চেষ্টা করুন।', en: 'NID verification failed. Check the details and try again.' },
  OWNER_ALREADY_REGISTERED: { bn: 'এই অ্যাকাউন্টে মালিক নিবন্ধন আগেই সম্পন্ন হয়েছে।', en: 'Owner registration is already complete for this account.' },
  OWNER_REGISTRATION_REQUIRED: { bn: 'আবেদনের আগে মালিক হিসেবে NID দিয়ে নিবন্ধন করুন।', en: 'Register as an owner with your NID before applying.' },

  OWNER_NID_VEHICLE_LIMIT_REACHED: {
    bn: 'একটি জাতীয় পরিচয়পত্রের অধীনে সর্বোচ্চ ৫টি ই-রিকশা নিবন্ধন করা যাবে। আপনার বিদ্যমান/প্রক্রিয়াধীন গাড়ির সংখ্যা ৫টি। (বিধি ৪(৮))',
    en: 'A maximum of 5 e-rickshaws may be registered under one NID. You already have 5 registered or pending vehicles. (Rule 4(8))',
  },
  APPLICATION_INVALID_STATE: { bn: 'আবেদনের বর্তমান অবস্থায় এই কাজ করা যাবে না।', en: 'This action is not allowed in the application’s current status.' },
  APPLICATION_INCOMPLETE: { bn: 'আবেদন অসম্পূর্ণ। সব আবশ্যক তথ্য ও নথি দিন।', en: 'The application is incomplete. Provide all required details and documents.' },
  DOCUMENTS_MISSING: { bn: 'সব আবশ্যক নথি আপলোড করুন।', en: 'Upload all required documents.' },
  CHASSIS_ALREADY_REGISTERED: { bn: 'এই চেসিস নম্বরে আগেই একটি আবেদন বা নিবন্ধন আছে।', en: 'This chassis number is already registered or under application.' },
  MOTOR_ALREADY_REGISTERED: { bn: 'এই মোটর নম্বরে আগেই একটি আবেদন বা নিবন্ধন আছে।', en: 'This motor number is already registered or under application.' },
  ZONE_WARD_MISMATCH: { bn: 'নির্বাচিত ওয়ার্ডটি নির্বাচিত জোনের অন্তর্ভুক্ত নয়।', en: 'The selected ward is not in the selected zone.' },
  MODEL_SEAT_MISMATCH: { bn: 'নির্বাচিত মডেলের আসন সংখ্যা গাড়ির ধরনের সাথে মিলছে না।', en: 'The selected model does not match the seat type.' },
  DRAFT_LIMIT_REACHED: { bn: 'একসাথে সর্বোচ্চ ৫টি খসড়া রাখা যায়। পুরোনো খসড়া জমা দিন বা মুছে ফেলুন।', en: 'You can keep at most 5 drafts. Submit or delete an existing draft.' },

  FILE_TOO_LARGE: { bn: 'ফাইলের আকার সর্বোচ্চ ৫ MB হতে পারে।', en: 'Files may be at most 5 MB.' },
  FILE_TYPE_NOT_ALLOWED: { bn: 'শুধু JPG, PNG বা PDF ফাইল গ্রহণযোগ্য।', en: 'Only JPG, PNG or PDF files are accepted.' },
  FILE_REJECTED_BY_SCAN: { bn: 'ফাইলটি নিরাপত্তা পরীক্ষায় উত্তীর্ণ হয়নি।', en: 'The file failed the security scan.' },
  DOCUMENT_TYPE_INVALID: { bn: 'নথির ধরন সঠিক নয়।', en: 'Invalid document type.' },

  // Phase 2
  STEP_UP_INVALID: { bn: 'নিশ্চিতকরণ কোড সঠিক নয় বা আগে ব্যবহার হয়েছে। Authenticator অ্যাপের নতুন কোড দিন।', en: 'The confirmation code is wrong or already used. Enter a new code from your authenticator app.' },
  SEPARATION_OF_DUTIES: { bn: 'দায়িত্ব বিভাজন: যে কর্মকর্তা আগের ধাপটি করেছেন তিনি এই ধাপ করতে পারবেন না।', en: 'Separation of duties: the officer who performed the earlier step cannot perform this one.' },
  APPROVAL_GATES_NOT_MET: { bn: 'অনুমোদনের সব শর্ত পূরণ হয়নি। চেকলিস্ট দেখুন।', en: 'Not all approval conditions are met. See the checklist.' },
  APPROVAL_DECISION_MISSING: { bn: 'অনুমোদনের সিদ্ধান্ত রেকর্ড ছাড়া অবস্থা পরিবর্তন করা যাবে না।', en: 'Status cannot change to approved without a recorded decision.' },
  INSPECTION_ALREADY_SCHEDULED: { bn: 'এই আবেদনের একটি পরিদর্শন আগেই নির্ধারিত আছে।', en: 'An inspection is already scheduled for this application.' },
  FITNESS_ALREADY_CERTIFIED: { bn: 'এই গাড়ির বৈধ ফিটনেস সনদ আছে।', en: 'This vehicle already has a valid fitness certificate.' },
  INSPECTION_INVALID_STATE: { bn: 'পরিদর্শনের বর্তমান অবস্থায় এই কাজ করা যাবে না।', en: 'This action is not allowed in the inspection’s current status.' },
  FEE_SCHEDULE_MISSING: { bn: 'ফি তালিকা পাওয়া যায়নি। প্রশাসককে জানান।', en: 'Fee schedule not found. Contact the administrator.' },
  INVOICE_ALREADY_PAID: { bn: 'এই ইনভয়েসের ফি আগেই পরিশোধিত।', en: 'This invoice is already paid.' },
  PAYMENT_AMOUNT_MISMATCH: { bn: 'টাকার পরিমাণ ইনভয়েসের মোট ফির সমান নয়।', en: 'The amount does not equal the invoice total.' },
  PAYMENT_SIGNATURE_INVALID: { bn: 'পেমেন্ট বার্তার স্বাক্ষর সঠিক নয়।', en: 'Invalid payment message signature.' },
  CHALLAN_ALREADY_USED: { bn: 'এই চালান নম্বর আগেই ব্যবহার হয়েছে।', en: 'This challan number has already been used.' },
  APPEAL_WINDOW_CLOSED: { bn: 'আপিলের সময়সীমা (১০ কার্যদিবস) শেষ হয়েছে।', en: 'The appeal period (10 working days) has ended.' },
  APPEAL_ALREADY_FILED: { bn: 'এই সিদ্ধান্তের বিরুদ্ধে আপিল আগেই করা হয়েছে।', en: 'An appeal against this decision has already been filed.' },
  APPEAL_INVALID_STATE: { bn: 'আপিলটি আর সিদ্ধান্তের অপেক্ষায় নেই।', en: 'This appeal is no longer pending.' },
  REGISTRATION_ALREADY_ISSUED: { bn: 'এই আবেদনের নম্বর প্লেট আগেই ইস্যু হয়েছে।', en: 'A plate has already been issued for this application.' },
  REGISTRATION_NOT_ACTIVE: { bn: 'নিবন্ধনটি সক্রিয় নয়।', en: 'The registration is not active.' },
  PLATE_SERIES_EXHAUSTED: { bn: 'এই জোনের প্লেট নম্বর (৯৯৯৯) শেষ। DSCC-এর সিদ্ধান্ত প্রয়োজন।', en: 'This zone’s plate numbers (9999) are used up. DSCC decision needed.' },

  ZONE_PLATE_CODE_TAKEN: { bn: 'এই প্লেট অঞ্চল কোড অন্য জোনে ব্যবহৃত হচ্ছে।', en: 'This plate area code is used by another zone.' },
} as const;

export type ErrorCode = keyof typeof errorMessages;

export function errorMessage(code: string, lang: 'bn' | 'en' = 'bn'): string {
  const m = (errorMessages as Record<string, { bn: string; en: string }>)[code];
  return m ? m[lang] : errorMessages.INTERNAL_ERROR[lang];
}
