import { expect, test, type Page } from '@playwright/test';

/**
 * Boots the real app, waits for traffic, and saves screenshots to artifacts/screens/
 * so humans and agents can look at what is actually rendered.
 */
const stat = (page: Page, key: 'active' | 'completed') =>
  page.evaluate((k) => window.__towns?.stats()?.[k] ?? 0, key);

test('map renders and traffic flows', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text());
  });

  // Overview at 8x: wait until trips actually complete end to end.
  await page.goto('/?scenario=roundabout&seed=1&speed=8');
  await expect.poll(() => stat(page, 'completed'), { timeout: 45_000 }).toBeGreaterThan(0);
  await page.screenshot({ path: 'artifacts/screens/overview.png' });

  // Close-ups of the roundabout, plain and with the lane graph.
  await page.goto('/?scenario=roundabout&seed=1&speed=8&x=0&y=0&mpp=0.14');
  await expect.poll(() => stat(page, 'active'), { timeout: 30_000 }).toBeGreaterThan(5);
  await page.waitForTimeout(1500);
  await page.screenshot({ path: 'artifacts/screens/roundabout.png' });

  await page.goto('/?scenario=roundabout&seed=1&speed=8&x=0&y=0&mpp=0.14&lanes=1');
  await expect.poll(() => stat(page, 'active'), { timeout: 30_000 }).toBeGreaterThan(5);
  await page.screenshot({ path: 'artifacts/screens/roundabout-lanes.png' });

  expect(errors).toEqual([]);
});

test('residential catalogue and sample street render', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto('/?catalogue=1');
  await expect(page.locator('.catalogue')).toHaveAttribute('data-ready', 'true', { timeout: 30_000 });
  await expect(page.locator('figure canvas')).toHaveCount(24);
  await page.getByRole('link', { name: 'Sample street' }).click();
  await page.locator('#street').screenshot({ path: 'artifacts/screens/building-street.png' });
  await page.locator('#street').evaluate(el => { el.setAttribute('hidden', ''); });
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.screenshot({ fullPage: true, path: 'artifacts/screens/building-catalogue.png' });
  expect(errors).toEqual([]);
});
