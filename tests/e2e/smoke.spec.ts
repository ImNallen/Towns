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

test('painted plots read at map zoom', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  const view = { x: 0, y: 0, mpp: 0.27 };
  await page.goto(`/?scenario=meadow&seed=1&speed=0&x=${view.x}&y=${view.y}&mpp=${view.mpp}`);
  const editor = () => page.evaluate(() => window.__towns?.editor());
  await expect.poll(editor).toMatchObject({ pending: false });
  const box = await page.locator('#map').boundingBox();
  if (!box) throw new Error('Missing map');
  const at = (x: number, y: number) => [box.x + box.width / 2 + (x - view.x) / view.mpp, box.y + box.height / 2 - (y - view.y) / view.mpp] as const;
  await page.keyboard.press('z');
  for (const [from, to, y] of [[-140, -60, 24.5], [60, 140, -24.5]] as const) {
    await page.mouse.move(...at(from, y));
    await page.mouse.down();
    await page.mouse.move(...at(to, y), { steps: 10 });
    await page.mouse.up();
    await expect.poll(editor).toMatchObject({ pending: false });
  }
  expect((await editor())?.zoned).toBeGreaterThan(60);
  await page.keyboard.press('v');
  await page.mouse.move(0, 0);
  await page.screenshot({ path: 'artifacts/screens/meadow-zone-paint-map.png' });
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
