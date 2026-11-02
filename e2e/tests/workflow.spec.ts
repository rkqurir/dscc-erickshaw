import AxeBuilder from '@axe-core/playwright';
import { Browser, Page, expect, test } from '@playwright/test';
import { ADMIN, CSRF, PNG, PORTAL, acceptConsent, citizenLogin, createSubmittedApplication, freshTotp, registerOwnerViaApi, staffLogin } from './helpers';

/**
 * Phase 2 end to end: fee payment through the simulated gateway, verification checklist, fitness inspection
 * with countersignature, approval with step-up TOTP, plate and QR issue, public QR verification, correction
 * request and resubmission, rejection with written reasons and the Rule 4(7) appeal. Every step is done by
 * a different officer, as separation of duties requires.
 */
const CHECK_LABELS = [
  'মালিকের পরিচয় (NID কপি, নাম, জন্ম তারিখ, ছবি)',
  'যোগ্যতা: নাগরিক, ১৮+, সত্যপাঠ (বিধি ৪(১))',
  'গাড়ির চার দিকের ছবি ও মডেল',
  'চেসিস ও মোটর নম্বর',
  'চালকের NID ও ছবি',
  'জোন, ওয়ার্ড ও চার্জিং স্থান',
];
const FIT_LABELS = ['ব্রেক', 'লাইটিং', 'হর্ন', 'গতি নিয়ন্ত্রক', 'চেসিস ও বডি', 'স্পিডোমিটার (বিধি ৫(৩))'];
const TOTP_LABEL = /নিশ্চিতকরণ কোড/;

test.describe.serial('Phase 2 workflow: verification, inspection, payment, decision, plate/QR and appeal', () => {
  const pages = new Map<string, Page>();
  let citizen: Page;
  let app: { id: string; applicationNumber: string };
  let app2: { id: string; applicationNumber: string };

  /** One signed-in browser context per officer, kept for the whole suite. */
  async function as(browser: Browser, email: string): Promise<Page> {
    let p = pages.get(email);
    if (!p) {
      p = await (await browser.newContext({ locale: 'bn-BD', timezoneId: 'Asia/Dhaka' })).newPage();
      await staffLogin(p, email);
      pages.set(email, p);
    }
    return p;
  }

  test.beforeAll(async ({ browser }) => {
    citizen = await (await browser.newContext({ locale: 'bn-BD', timezoneId: 'Asia/Dhaka' })).newPage();
    await citizenLogin(citizen);
    await acceptConsent(citizen);
    await registerOwnerViaApi(citizen);
    app = await createSubmittedApplication(citizen);
    app2 = await createSubmittedApplication(citizen);
  });

  test.afterAll(async () => {
    for (const p of [citizen, ...pages.values()]) await p.context().close();
  });

  test('citizen pays the Schedule 2 fees through the simulated gateway and receives a receipt', async () => {
    await citizen.goto(`${PORTAL}/applications/${app.id}`);
    const fee = citizen.getByTestId('fee-card');
    await expect(fee).toContainText('নিবন্ধন ফি');
    await expect(fee).toContainText('ফিটনেস সনদ ফি');
    await fee.getByRole('button', { name: 'অনলাইনে ফি পরিশোধ করুন' }).click();

    await expect(citizen).toHaveURL(/\/pay\/sim\//);
    await expect(citizen.getByRole('heading', { name: 'পেমেন্ট গেটওয়ে (ডেমো সিমুলেটর)' })).toBeVisible();
    await expect(citizen.getByText('এটি প্রকৃত পেমেন্ট নয়।', { exact: false })).toBeVisible();
    await citizen.getByRole('button', { name: 'সফল পেমেন্ট সিমুলেট করুন' }).click();

    await expect(citizen).toHaveURL(new RegExp(`/applications/${app.id}\\?payment=PAID`));
    await expect(citizen.getByText('পেমেন্ট সফল হয়েছে।')).toBeVisible();
    await expect(citizen.getByTestId('fee-card')).toContainText(/RCP-DSCC-\d{4}-\d{6}/);
    await expect(citizen.getByRole('button', { name: 'অনলাইনে ফি পরিশোধ করুন' })).toHaveCount(0);

    // A forged gateway callback (bad signature) is refused.
    const forged = await citizen.request.post(`${PORTAL}/api/v1/payments/webhook/simulator`, {
      headers: { 'x-payment-signature': 'AAAA' },
      data: { sessionId: '00000000-0000-0000-0000-000000000000', status: 'SUCCESS' },
    });
    expect(forged.status()).toBeGreaterThanOrEqual(400);
  });

  test('verification officer checks the file and schedules a fitness inspection', async ({ browser }) => {
    const v = await as(browser, 'verifier@dscc.test');
    await v.goto(`${ADMIN}/applications/${app.id}`);
    const wf = v.getByTestId('workflow');
    await wf.getByRole('button', { name: 'যাচাই শুরু করুন' }).click();
    await expect(wf).toContainText('যাচাই শুরু করেছেন: শাহানা পারভীন');
    for (const label of CHECK_LABELS) {
      await wf.getByRole('button', { name: `${label}: উত্তীর্ণ` }).click();
      await expect(wf.getByRole('button', { name: `${label}: উত্তীর্ণ` })).toBeDisabled();
    }
    // The verifier may not decide on a file they verified.
    await expect(wf.getByText('আপনি এই আবেদনের যাচাইকারী, তাই সিদ্ধান্ত দিতে পারবেন না (দায়িত্ব বিভাজন)।')).toBeVisible();
    await expect(wf.getByRole('button', { name: 'অনুমোদন করুন' })).toHaveCount(0);

    const tomorrow = new Date(Date.now() + 86_400_000 + 6 * 3_600_000).toISOString().slice(0, 10);
    await wf.locator('input[type="datetime-local"]').fill(`${tomorrow}T10:30`);
    await wf.getByRole('textbox', { name: 'স্থান', exact: true }).fill('DSCC অঞ্চল-২ ফিটনেস ইয়ার্ড, ধানমন্ডি');
    await wf.getByRole('button', { name: 'পরিদর্শনের সময় নির্ধারণ' }).click();
    await expect(wf).toContainText('DSCC অঞ্চল-২ ফিটনেস ইয়ার্ড, ধানমন্ডি');

    const axe = await new AxeBuilder({ page: v }).withTags(['wcag2a', 'wcag2aa']).analyze();
    expect(axe.violations.filter((x) => x.impact === 'serious' || x.impact === 'critical')).toEqual([]);
  });

  test('inspection officer records Schedule 4 results; a different traffic officer countersigns the certificate', async ({ browser }) => {
    const i = await as(browser, 'inspector@dscc.test');
    await i.goto(`${ADMIN}/inspections`);
    const card = i.getByTestId('inspection').filter({ hasText: app.applicationNumber });
    await card.getByText('ফলাফল লিখুন').click();
    for (const label of FIT_LABELS) await card.getByRole('group', { name: label }).getByLabel('উত্তীর্ণ').check();
    await card.getByRole('button', { name: 'ফলাফল সংরক্ষণ' }).click();
    await expect(i.getByTestId('inspection-flash')).toHaveText(`${app.applicationNumber}: পরিদর্শনের ফলাফল সংরক্ষিত। (উত্তীর্ণ)`);
    await i.getByRole('group', { name: 'অবস্থা' }).getByRole('button', { name: 'উত্তীর্ণ' }).click();
    const passed = i.getByTestId('inspection').filter({ hasText: app.applicationNumber });
    await expect(passed).toContainText('ট্রাফিক বিভাগের প্রতিস্বাক্ষরের অপেক্ষায়');

    // The countersigner's queue opens on passed inspections.
    const tr = await as(browser, 'traffic@dscc.test');
    await tr.goto(`${ADMIN}/inspections`);
    const card2 = tr.getByTestId('inspection').filter({ hasText: app.applicationNumber });
    await card2.getByRole('button', { name: 'প্রতিস্বাক্ষর করে সনদ ইস্যু' }).click();
    await expect(tr.getByTestId('inspection-flash')).toContainText(/সনদ ইস্যু হয়েছে: FIT-DSCC-\d{4}-\d{6}/);
    await expect(card2).toContainText(/ফিটনেস সনদ FIT-DSCC-\d{4}-\d{6}/);
  });

  test('approving officer sees every gate met and approves with a step-up code', async ({ browser }) => {
    const a = await as(browser, 'approver@dscc.test');
    await a.goto(`${ADMIN}/applications/${app.id}`);
    const gates = a.getByTestId('gates');
    await expect(gates.locator('li')).toHaveCount(8);
    await expect(gates.locator('li.no')).toHaveCount(0);
    const form = a.getByRole('form', { name: 'অনুমোদন করুন' });
    await form.getByLabel('অনুমোদনের মন্তব্য').fill('সব শর্ত পূরণ হয়েছে।');
    // A wrong code is refused and nothing changes.
    await form.getByLabel(TOTP_LABEL).fill('000000');
    await form.getByRole('button', { name: 'অনুমোদন করুন' }).click();
    await expect(form.locator('.alert-error')).toBeVisible();
    await form.getByLabel(TOTP_LABEL).fill(await freshTotp('approver@dscc.test'));
    await form.getByRole('button', { name: 'অনুমোদন করুন' }).click();
    await expect(a.getByTestId('decision-flash')).toHaveText('আবেদন অনুমোদিত হয়েছে।');
    await expect(form).toHaveCount(0);
    await expect(a.getByTestId('workflow')).toContainText('মাহবুব আলম');
  });

  test('plate officer issues the zone plate and signed QR; the public verify page shows no personal data', async ({ browser }) => {
    const p = await as(browser, 'plate@dscc.test');
    await p.goto(`${ADMIN}/registrations`);
    const card = p.getByTestId('registration-card').filter({ hasText: app.applicationNumber });
    await card.getByLabel(TOTP_LABEL).fill(await freshTotp('plate@dscc.test'));
    await card.getByRole('button', { name: 'প্লেট ও QR ইস্যু করুন' }).click();
    await expect(card).toContainText(/ইস্যু হয়েছে: ঢাকা দক্ষিণ-খ-[০-৯]{4}/);
    await expect(card).toContainText(/DSCC-Z2-\d{4}/);
    await expect(card.getByRole('img', { name: /QR কোড \(সংস্করণ/ })).toBeVisible();

    await citizen.goto(`${PORTAL}/applications/${app.id}`);
    const reg = citizen.getByTestId('registration');
    await expect(reg).toContainText('নিবন্ধন সম্পন্ন: নম্বর প্লেট ও QR কোড');
    await expect(reg.getByRole("img", { name: /^ঢাকা দক্ষিণ-খ-[০-৯]{4} \(DSCC-Z2-\d{4}\)$/ })).toBeVisible();
    await expect(reg.getByRole('img', { name: /QR কোড/ })).toBeVisible();
    const href = await reg.getByRole('link', { name: 'যাচাই পাতা খুলুন' }).getAttribute('href');
    expect(href).toMatch(/^\/v\/Q1\.DSCC\./);

    // Anyone can verify without logging in.
    const anon = await (await browser.newContext({ locale: 'bn-BD' })).newPage();
    await anon.goto(`${PORTAL}${href}`);
    await expect(anon.getByTestId('verify-result')).toContainText('বৈধ নিবন্ধন');
    await expect(anon.getByText(/DSCC-Z2-\d{4}/)).toBeVisible();
    await expect(anon.getByText(/পর্যন্ত বৈধ/)).toBeVisible();
    const body = await anon.locator('body').innerText();
    expect(body).not.toContain('জাহিদ হাসান');
    expect(body).not.toMatch(/018\d{8}/);
    // A tampered token is reported as forged.
    // Flip a data bit in the last signature character (A/Q/g/w are the only canonical endings).
    const tampered = href!.replace(/.$/, (c) => (c === 'A' ? 'Q' : 'A'));
    await anon.goto(`${PORTAL}${tampered}`);
    await expect(anon.getByTestId('verify-result')).toContainText('জাল বা ত্রুটিপূর্ণ QR কোড');
    await anon.context().close();
  });

  test('correction request, resubmission, rejection with written reasons and an allowed appeal', async ({ browser }) => {
    const v = await as(browser, 'verifier@dscc.test');
    await v.goto(`${ADMIN}/applications/${app2.id}`);
    const wf = v.getByTestId('workflow');
    await wf.getByRole('button', { name: 'যাচাই শুরু করুন' }).click();
    await wf.locator('summary', { hasText: 'সংশোধনের অনুরোধ' }).click();
    await wf.getByLabel('গাড়ির সামনের ছবি').check();
    await wf.getByLabel('আবেদনকারীর জন্য বার্তা').fill('সামনের ছবিতে নম্বর অংশ ঝাপসা, পরিষ্কার ছবি দিন।');
    await wf.getByRole('button', { name: 'সংশোধন চেয়ে ফেরত পাঠান' }).click();
    await expect(v.getByText('সংশোধন প্রয়োজন').first()).toBeVisible();

    // The citizen sees what to fix, replaces the photo and resubmits.
    await citizen.goto(`${PORTAL}/applications/${app2.id}`);
    const notice = citizen.getByTestId('correction-notice');
    await expect(notice).toContainText('সামনের ছবিতে নম্বর অংশ ঝাপসা');
    await expect(notice).toContainText('গাড়ির সামনের ছবি');
    await citizen.getByRole('button', { name: /নথি আপলোড/ }).click();
    await citizen.getByLabel('গাড়ির সামনের ছবি — আপলোড').setInputFiles({ name: 'সামনে.png', mimeType: 'image/png', buffer: PNG });
    await expect(citizen.getByTestId('doc-VEHICLE_PHOTO_FRONT')).toContainText('আপলোড হয়েছে');
    await citizen.getByRole('button', { name: /যাচাই ও জমা/ }).click();
    await citizen.getByRole('button', { name: 'সংশোধন করে আবার জমা দিন' }).click();
    await expect(citizen.getByTestId('application-number')).toHaveText(app2.applicationNumber);
    await expect(citizen.getByText('জমা হয়েছে').first()).toBeVisible();

    // Verification restarts; a different approving officer rejects with reasons.
    const restart = await v.request.post(`${ADMIN}/api/v1/admin/applications/${app2.id}/start-verification`, { headers: CSRF });
    expect(restart.status()).toBe(200);
    const r = await as(browser, 'approver2@dscc.test');
    await r.goto(`${ADMIN}/applications/${app2.id}`);
    const form = r.getByRole('form', { name: 'না-মঞ্জুর করুন' });
    r.once('dialog', (d) => void d.accept());
    await form.getByLabel('নথি সঠিক নয়').check();
    await form.getByLabel('আবেদনকারীকে পাঠানো লিখিত ব্যাখ্যা').fill('গাড়ির ছবি ও চেসিস নম্বর মিলছে না।');
    await form.getByLabel(TOTP_LABEL).fill(await freshTotp('approver2@dscc.test'));
    await form.getByRole('button', { name: 'না-মঞ্জুর করুন' }).click();
    await expect(r.getByTestId('decision-flash')).toContainText('আবেদন না-মঞ্জুর হয়েছে। আপিলের শেষ তারিখ');
    await expect(r.getByTestId('workflow')).toContainText('আপিলের শেষ তারিখ:');

    // The applicant reads the written reasons and appeals.
    await citizen.goto(`${PORTAL}/applications/${app2.id}`);
    const rej = citizen.getByTestId('rejection');
    await expect(rej).toContainText('নথি সঠিক নয়');
    await expect(rej).toContainText('গাড়ির ছবি ও চেসিস নম্বর মিলছে না।');
    await rej.getByLabel('আপিলের কারণ').fill('চেসিস নম্বর সঠিক; ছবিটি নতুন করে তোলা হয়েছে, অনুগ্রহ করে পুনর্বিবেচনা করুন।');
    await rej.getByRole('button', { name: 'আপিল জমা দিন' }).click();
    await expect(rej).toContainText('আপিলের অবস্থা: সিদ্ধান্তের অপেক্ষায়');

    // The higher authority allows the appeal; the file goes back for a fresh decision.
    const ap = await as(browser, 'appeal@dscc.test');
    await ap.goto(`${ADMIN}/appeals`);
    const card = ap.getByTestId('appeal').filter({ hasText: app2.applicationNumber });
    await expect(card).toContainText('গাড়ির ছবি ও চেসিস নম্বর মিলছে না।');
    await card.getByLabel('সিদ্ধান্তের ব্যাখ্যা').fill('আবেদনকারীর ব্যাখ্যা গ্রহণযোগ্য, পুনরায় যাচাই করা হোক।');
    await card.getByLabel(TOTP_LABEL).fill(await freshTotp('appeal@dscc.test'));
    await card.getByRole('button', { name: 'আপিল মঞ্জুর (পুনর্বিবেচনায় ফেরত)' }).click();
    await expect(card).toContainText('মঞ্জুর');

    await citizen.goto(`${PORTAL}/applications/${app2.id}`);
    await expect(citizen.getByText('যাচাই চলছে').first()).toBeVisible();
  });

  test('roles are enforced: an inspector cannot approve and a citizen cannot reach the gateway session of another', async ({ browser }) => {
    const i = await as(browser, 'inspector@dscc.test');
    const r = await i.request.post(`${ADMIN}/api/v1/admin/applications/${app2.id}/approve`, { headers: CSRF, data: { totp: '123456' } });
    expect(r.status()).toBe(403);
    const other = await (await browser.newContext()).newPage();
    await citizenLogin(other);
    await acceptConsent(other);
    const c = await other.request.post(`${PORTAL}/api/v1/applications/${app2.id}/payments/checkout`, { headers: CSRF });
    expect([403, 404]).toContain(c.status());
    await other.context().close();
  });
});
