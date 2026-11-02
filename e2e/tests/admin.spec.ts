import AxeBuilder from '@axe-core/playwright';
import { expect, test } from '@playwright/test';
import { ADMIN, PORTAL, acceptConsent, citizenLogin, registerOwnerViaApi, staffLogin, submitApplicationViaApi } from './helpers';

test.describe.serial('DSCC admin dashboard', () => {
  let applicationNumber = '';

  test.beforeAll(async ({ browser }) => {
    const page = await browser.newPage();
    await citizenLogin(page);
    await acceptConsent(page);
    await registerOwnerViaApi(page);
    applicationNumber = await submitApplicationViaApi(page);
    await page.close();
  });

  test('officer signs in with password + TOTP and sees the submitted application in the queue', async ({ page }) => {
    await page.goto(`${ADMIN}/applications`);
    await expect(page).toHaveURL(/\/login$/);
    await page.getByLabel('দাফতরিক ইমেইল').fill('intake@dscc.test');
    await page.getByLabel('পাসওয়ার্ড').fill('wrong-password-123');
    await page.getByRole('button', { name: 'লগইন' }).click();
    await expect(page.locator('.alert-error')).toContainText('ইমেইল বা পাসওয়ার্ড সঠিক নয়।');

    await staffLogin(page, 'intake@dscc.test');
    await expect(page.getByRole('heading', { name: 'আবেদন ক্যু' })).toBeVisible();
    await expect(page.getByText('আবেদন খুলে যাচাই, সংশোধন, পরিদর্শন ও সিদ্ধান্তের কাজ করুন।', { exact: false })).toBeVisible();
    // Intake officers cannot manage zones, but can view them.
    await expect(page.getByRole('link', { name: 'জোন কনফিগারেশন' })).toBeVisible();
    await page.getByLabel('আবেদন নম্বর').fill(applicationNumber);
    await page.getByRole('button', { name: 'খুঁজুন' }).click();
    await expect(page.getByRole('link', { name: applicationNumber })).toBeVisible();
    await expect(page.getByText('সময়মতো').first()).toBeVisible();

    await page.getByRole('link', { name: applicationNumber }).click();
    await expect(page.getByRole('heading', { name: new RegExp(applicationNumber) })).toBeVisible();
    await expect(page.getByText(/••••••\d{4}/).first()).toBeVisible();
    await expect(page.getByTestId('owner-quota')).toContainText('এই NID-এ গাড়ি: ১/৫');
    await expect(page.getByRole('link', { name: 'ফিটনেস সার্টিফিকেট' })).toBeVisible();
    const res = await page.request.get(await page.getByRole('link', { name: 'ফিটনেস সার্টিফিকেট' }).getAttribute('href').then((h) => `${ADMIN}${h}`));
    expect(res.headers()['content-type']).toBe('application/pdf');

    await page.goto(`${ADMIN}/zones`);
    await expect(page.getByTestId('zone-Z1')).toBeVisible();
    await expect(page.getByRole('button', { name: 'সম্পাদনা' })).toHaveCount(0);
  });

  test('DSCC admin edits a zone, sees the plate preview, contrast warning and version history', async ({ page }) => {
    await staffLogin(page, 'admin@dscc.test');
    await expect(page.getByRole('heading', { name: 'আবেদন ক্যু' })).toBeVisible();
    await page.getByRole('link', { name: 'জোন কনফিগারেশন' }).click();
    const z1 = page.getByTestId('zone-Z1');
    await expect(z1.getByRole('img', { name: 'ঢাকা দক্ষিণ-ক-২৩২৪' })).toBeVisible();
    await expect(z1.getByText('DSCC-Z1-2324')).toBeVisible();
    const z3 = page.getByTestId('zone-Z3');
    await expect(z3.getByTestId('contrast-warning')).toBeVisible();

    await z3.getByRole('button', { name: 'সম্পাদনা' }).click();
    await z3.locator('input[name="plateBackgroundColour"]').fill('#7A5C00');
    await z3.getByLabel('জোনের গাড়ির সংখ্যা (বিধি ৩)').fill('1500');
    await z3.getByLabel('অনুমোদন অবস্থা').selectOption('PROPOSED');
    await z3.getByLabel('পরিবর্তনের কারণ').fill('সাদা অক্ষর পড়ার জন্য গাঢ় হলুদ');
    await z3.getByRole('button', { name: 'সংরক্ষণ করুন' }).click();

    const z3After = page.getByTestId('zone-Z3');
    await expect(z3After.getByText('জোন হালনাগাদ হয়েছে।')).toBeVisible();
    await expect(z3After.getByTestId('contrast-warning')).toHaveCount(0);
    await expect(z3After.getByText('প্রস্তাবিত')).toBeVisible();
    await z3After.getByRole('button', { name: 'সংস্করণ ইতিহাস' }).click();
    await expect(z3After.getByText('সাদা অক্ষর পড়ার জন্য গাঢ় হলুদ')).toBeVisible();
    await expect(z3After.getByText('আনিসুর রহমান')).toBeVisible();

    const axe = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa']).analyze();
    expect(axe.violations.filter((v) => v.impact === 'serious' || v.impact === 'critical')).toEqual([]);
  });

  test('a citizen session cannot reach staff APIs', async ({ page }) => {
    await citizenLogin(page);
    await acceptConsent(page);
    const r = await page.request.get(`${PORTAL}/api/v1/admin/applications`);
    expect(r.status()).toBe(401);
  });
});
