import { expect, test } from '@playwright/test';
import { PORTAL, acceptConsent, citizenLogin, registerOwnerViaApi, submitApplicationViaApi } from './helpers';

test('mobile: login, dashboard and application list fit the screen without horizontal scrolling', async ({ page }) => {
  await citizenLogin(page);
  await acceptConsent(page);
  await registerOwnerViaApi(page);
  const number = await submitApplicationViaApi(page);
  await page.goto(`${PORTAL}/dashboard`);
  await expect(page.getByRole('link', { name: number })).toBeVisible();
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow).toBeLessThanOrEqual(1);
  // Touch targets are at least 44px tall.
  const h = await page.getByRole('button', { name: 'নতুন আবেদন' }).evaluate((el) => el.getBoundingClientRect().height);
  expect(h).toBeGreaterThanOrEqual(44);
});
