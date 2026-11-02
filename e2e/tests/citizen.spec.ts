import AxeBuilder from '@axe-core/playwright';
import { expect, test } from '@playwright/test';
import { PDF, PNG, PORTAL, REQUIRED_DOCS, acceptConsent, citizenLogin, registerOwnerViaApi, submitApplicationViaApi, uniqueNid, uniquePhone } from './helpers';

const DOC_LABELS: Record<string, string> = {
  OWNER_NID_COPY: 'মালিকের NID-এর সত্যায়িত কপি',
  OWNER_PHOTO: 'মালিকের ছবি',
  VEHICLE_PHOTO_FRONT: 'গাড়ির সামনের ছবি',
  VEHICLE_PHOTO_BACK: 'গাড়ির পেছনের ছবি',
  VEHICLE_PHOTO_LEFT: 'গাড়ির বাম পাশের ছবি',
  VEHICLE_PHOTO_RIGHT: 'গাড়ির ডান পাশের ছবি',
  FITNESS_CERTIFICATE: 'ফিটনেস সার্টিফিকেট',
  FEE_RECEIPT: 'নিবন্ধন ফি জমার রশিদ',
  DRIVER_PHOTO: 'চালকের ছবি',
  DRIVER_NID_COPY: 'চালকের NID-এর কপি',
};

test('citizen registers with OTP, becomes an owner, fills the application in Bengali and receives DSCC-YYYY-NNNNNN', async ({ page }) => {
  await citizenLogin(page);
  await acceptConsent(page);

  // Owner registration form
  await page.getByRole('link', { name: 'মালিক নিবন্ধন শুরু করুন' }).click();
  await expect(page.getByRole('heading', { name: 'মালিক নিবন্ধন (জাতীয় পরিচয়পত্র)' })).toBeVisible();
  await page.getByRole('button', { name: 'মালিক নিবন্ধন সম্পন্ন করুন' }).click();
  await expect(page.getByText('এই ঘরটি পূরণ করুন।').first()).toBeVisible();
  const nid = uniqueNid();
  // Bengali digits are accepted and normalised.
  await page.getByLabel('জাতীয় পরিচয়পত্র নম্বর').fill(nid.replace(/\d/g, (d) => '০১২৩৪৫৬৭৮৯'[Number(d)]));
  await page.getByLabel('জন্ম তারিখ').fill('1986-03-26');
  await page.getByLabel('নাম (বাংলায়)').fill('মোঃ করিম শেখ');
  await page.getByLabel('পিতার নাম').fill('মোঃ রহিম শেখ');
  await page.getByLabel('মাতার নাম').fill('আমেনা খাতুন');
  await page.getByLabel('বর্তমান ঠিকানা').fill('১২ লালবাগ রোড, ঢাকা');
  await page.getByLabel('স্থায়ী ঠিকানা').fill('গ্রাম: চরপাড়া, ময়মনসিংহ');
  await page.getByLabel('শিক্ষাগত যোগ্যতা').selectOption('SSC');
  await page.getByLabel('আমি বাংলাদেশের নাগরিক।').check();
  await page.getByLabel('আমি আদালত কর্তৃক অপ্রকৃতিস্থ ঘোষিত নই।').check();
  await page.getByRole('button', { name: 'মালিক নিবন্ধন সম্পন্ন করুন' }).click();

  await expect(page.getByRole('heading', { name: 'আমার ড্যাশবোর্ড' })).toBeVisible();
  await expect(page.getByText(`NID ••••••${nid.slice(-4)}`)).toBeVisible();
  await expect(page.getByTestId('quota-line')).toHaveText('নিবন্ধিত ০ · প্রক্রিয়াধীন ০ · অন্য সিটিতে ০ · অবশিষ্ট ৫');

  // Application wizard
  await page.getByRole('button', { name: 'নতুন আবেদন' }).click();
  await expect(page.getByRole('heading', { name: 'ই-রিকশা নিবন্ধনের আবেদন' })).toBeVisible();
  await page.getByLabel('গাড়ির ধরন').selectOption('TWO_SEAT');
  await page.getByLabel('অনুমোদিত প্রস্তুতকারক ও মডেল').selectOption({ label: 'EA-200 (২ আসন)' });
  await page.getByLabel('তৈরির সাল').fill('2025');
  await page.getByLabel('ব্যাটারির ধরন').selectOption('LITHIUM_ION');
  await page.getByLabel('চেসিস নম্বর').fill(`CH-E2E-${Date.now() % 1_000_000}`);
  await page.getByLabel('মোটর নম্বর').fill(`MT-E2E-${Date.now() % 1_000_000}`);
  await page.getByLabel('স্পিডোমিটার আছে').check();
  await expect(page.getByTestId('save-state')).toContainText('সর্বশেষ সংরক্ষণ');
  await page.getByRole('button', { name: 'পরবর্তী' }).click();

  await page.getByRole('radio', { name: /Z1/ }).check();
  await page.getByLabel('ওয়ার্ড').selectOption({ label: 'ওয়ার্ড নং ১' });
  await page.getByLabel('চার্জিং স্টেশন / গ্যারেজের নাম ও ঠিকানা').fill('লালবাগ সৌর চার্জিং স্টেশন, লালবাগ, ঢাকা');
  await page.getByRole('button', { name: 'পরবর্তী' }).click();

  await page.getByLabel('চালকের নাম (বাংলায়)').fill('আব্দুল কাদের');
  await page.getByLabel('চালকের জাতীয় পরিচয়পত্র নম্বর').fill(uniqueNid());
  await page.getByLabel('চালকের জন্ম তারিখ').fill('1990-07-01');
  await page.getByLabel('চালকের মোবাইল নম্বর').fill(uniquePhone());
  await page.getByLabel('চালকের ঠিকানা').fill('কামরাঙ্গীরচর, ঢাকা');
  await page.getByRole('button', { name: 'পরবর্তী' }).click();

  // Try to submit early: the review step lists what is missing.
  await page.getByRole('button', { name: /যাচাই ও জমা/ }).click();
  await page.getByRole('button', { name: 'আবেদন জমা দিন' }).click();
  await expect(page.getByTestId('review-problems')).toContainText('বাকি নথি');

  await page.getByRole('button', { name: /নথি আপলোড/ }).click();
  for (const type of REQUIRED_DOCS) {
    const pdf = type === 'FITNESS_CERTIFICATE' || type === 'FEE_RECEIPT';
    await page.getByLabel(`${DOC_LABELS[type]} — আপলোড`).setInputFiles({ name: pdf ? 'নথি.pdf' : 'ছবি.png', mimeType: pdf ? 'application/pdf' : 'image/png', buffer: pdf ? PDF : PNG });
    await expect(page.getByTestId(`doc-${type}`)).toContainText('আপলোড হয়েছে');
  }
  // A non-image file is rejected with a Bengali message.
  await page.getByLabel('বিমার কাগজ — আপলোড').setInputFiles({ name: 'x.png', mimeType: 'image/png', buffer: Buffer.from('not really a png') });
  await expect(page.getByTestId('doc-INSURANCE_DOCUMENT')).toContainText('শুধু JPG, PNG বা PDF ফাইল গ্রহণযোগ্য।');

  await page.getByRole('button', { name: 'পরবর্তী' }).click();
  await page.getByLabel(/আমি ঘোষণা করছি/).check();
  await page.getByRole('button', { name: 'আবেদন জমা দিন' }).click();

  await expect(page.getByRole('heading', { name: 'আবেদন সফলভাবে জমা হয়েছে' })).toBeVisible();
  const number = await page.getByTestId('application-number').innerText();
  expect(number).toMatch(/^DSCC-20\d{2}-\d{6}$/);

  await page.getByRole('link', { name: /আমার ড্যাশবোর্ড/ }).click();
  await expect(page.getByRole('link', { name: number })).toBeVisible();
  await expect(page.getByTestId('quota-line')).toHaveText('নিবন্ধিত ০ · প্রক্রিয়াধীন ১ · অন্য সিটিতে ০ · অবশিষ্ট ৪');
});

test('the dashboard blocks a sixth vehicle under one NID with the Rule 4(8) message, and withdrawal frees a slot', async ({ page }) => {
  await citizenLogin(page);
  await acceptConsent(page);
  await registerOwnerViaApi(page);
  for (let i = 0; i < 5; i++) await submitApplicationViaApi(page);
  await page.reload();
  await expect(page.getByTestId('limit-reached')).toContainText('একটি জাতীয় পরিচয়পত্রের অধীনে সর্বোচ্চ ৫টি ই-রিকশা নিবন্ধন করা যাবে');
  await expect(page.getByRole('button', { name: 'নতুন আবেদন' })).toBeDisabled();

  page.once('dialog', (d) => void d.accept());
  await page.getByRole('link', { name: /^DSCC-/ }).first().click();
  await page.getByRole('button', { name: 'আবেদন প্রত্যাহার করুন' }).click();
  await expect(page.getByText('আবেদন প্রত্যাহার করা হয়েছে।')).toBeVisible();
  await page.goto(`${PORTAL}/dashboard`);
  await expect(page.getByTestId('quota-line')).toContainText('অবশিষ্ট ১');
  await expect(page.getByRole('button', { name: 'নতুন আবেদন' })).toBeEnabled();
});

test('a wrong OTP shows a Bengali error and English is available', async ({ page }) => {
  await page.goto(`${PORTAL}/login`);
  await page.getByLabel('মোবাইল নম্বর').fill('01299999999');
  await page.getByRole('button', { name: 'OTP পাঠান' }).click();
  await expect(page.getByText('সঠিক বাংলাদেশি মোবাইল নম্বর দিন।')).toBeVisible();

  const phone = uniquePhone();
  await page.getByLabel('মোবাইল নম্বর').fill(phone);
  await page.getByRole('button', { name: 'OTP পাঠান' }).click();
  const otp = await (await import('./helpers')).readOtp(page.request, phone);
  await page.getByLabel('৬ অঙ্কের OTP').fill(otp === '123456' ? '654321' : '123456');
  await page.getByRole('button', { name: 'যাচাই করুন' }).click();
  await expect(page.locator('.alert-error')).toContainText('OTP সঠিক নয় অথবা মেয়াদ শেষ');

  await page.getByRole('button', { name: 'English' }).click();
  await expect(page.getByRole('button', { name: 'Verify' })).toBeVisible();
  await page.reload();
  await expect(page.locator('html')).toHaveAttribute('lang', 'en');
  await page.getByRole('button', { name: 'বাংলা' }).click();
  await expect(page.getByRole('heading', { name: 'মোবাইল নম্বর দিয়ে লগইন বা নিবন্ধন' })).toBeVisible();
});

test('citizen pages have no serious accessibility violations', async ({ page }) => {
  await page.goto(`${PORTAL}/login`);
  const login = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa']).analyze();
  expect(login.violations.filter((v) => v.impact === 'serious' || v.impact === 'critical')).toEqual([]);
  await citizenLogin(page);
  await acceptConsent(page);
  const dash = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa']).analyze();
  expect(dash.violations.filter((v) => v.impact === 'serious' || v.impact === 'critical')).toEqual([]);
});
