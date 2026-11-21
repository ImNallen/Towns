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

test('building catalogue and sample street render', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto('/?catalogue=1');
  await expect(page.locator('.catalogue')).toHaveAttribute('data-ready', 'true', { timeout: 30_000 });
  await expect(page.locator('figure canvas')).toHaveCount(36);
  await page.locator('#shops').screenshot({ path: 'artifacts/screens/shop-catalogue.png' });
  await page.locator('#workplaces').screenshot({ path: 'artifacts/screens/workplace-catalogue.png' });
  await page.getByRole('link', { name: 'Sample street' }).click();
  await page.locator('#street').screenshot({ path: 'artifacts/screens/building-street.png' });
  await page.locator('#street').evaluate(el => { el.setAttribute('hidden', ''); });
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.screenshot({ fullPage: true, path: 'artifacts/screens/building-catalogue.png' });
  expect(errors).toEqual([]);
});

test('painted residential frontage grows into a lived-in street', async ({ page }) => {
  test.setTimeout(150_000);
  const errors: string[] = [];
  page.on('pageerror', e => errors.push(e.message));
  await page.goto('/?scenario=meadow&seed=1&speed=0&x=70&y=8&mpp=0.1');
  const editor = () => page.evaluate(() => window.__towns?.editor());
  await expect.poll(editor).toMatchObject({ pending: false });
  const box = (await page.locator('#map').boundingBox())!;
  const at = (x: number, y: number) => [box.x + box.width / 2 + (x - 70) / 0.1, box.y + box.height / 2 - (y - 8) / 0.1] as const;
  await page.keyboard.press('z');
  for (const y of [-24, 40]) {
    await page.mouse.move(...at(46, y));
    await page.mouse.down();
    await page.mouse.move(...at(80, y), { steps: 12 });
    await page.mouse.up();
    await expect.poll(editor).toMatchObject({ pending: false });
  }
  await page.getByRole('button', {name: 'Pan'}).click();
  await page.mouse.move(0, 0);
  await page.evaluate(() => window.__towns!.setSpeed(120));
  const town = () => page.evaluate(() => window.__towns!.town()!);
  await expect.poll(async () => (await town()).households.length, {timeout: 60_000}).toBeGreaterThan(12);
  await page.evaluate(() => window.__towns!.setSpeed(0));
  const first = (await town()).households.find(h => h.lot)!.lot!;
  await page.mouse.click(...at(first.x, first.y));
  await expect(page.getByRole('region', {name: 'Household'})).toBeVisible();
  await page.screenshot({path: 'artifacts/screens/growth-first-home.png'});
  await page.keyboard.press('Escape');
  await page.evaluate(() => window.__towns!.setSpeed(120));
  await expect.poll(async () => (await town()).day, {timeout: 100_000}).toBeGreaterThanOrEqual(4);
  await page.evaluate(() => window.__towns!.setSpeed(0));
  expect((await town()).households.filter(h => h.lot).length).toBeGreaterThan(1);
  expect((await town()).households.some(h => h.lot && h.wages > 0)).toBe(true);
  await page.screenshot({path: 'artifacts/screens/growth-day-four.png'});
  expect(errors).toEqual([]);
});

async function connectedStreet(page: Page) {
  await page.goto('/?scenario=meadow&seed=1&speed=0&x=20&y=8&mpp=0.15');
  const editor = () => page.evaluate(() => window.__towns?.editor());
  await expect.poll(editor).toMatchObject({ tool: 'road', pending: false });
  const box = (await page.locator('#map').boundingBox())!;
  const at = (x: number, y: number) => [
    box.x + box.width / 2 + (x - 20) / 0.15,
    box.y + box.height / 2 - (y - 8) / 0.15,
  ] as const;
  const drag = async (x: number, y: number, end: number) => {
    await page.mouse.move(...at(x, y));
    await page.mouse.down();
    await page.mouse.move(...at(end, y), { steps: 16 });
    await page.mouse.up();
  };
  await drag(45, 8, -35);
  await expect.poll(editor).toMatchObject({ roadCount: 1, pending: false });
  await page.keyboard.press('z');
  return { at, drag, editor };
}

test('a fully grown painted street in Meadow Vale', async ({ page }) => {
  test.setTimeout(220_000);
  const { drag, editor } = await connectedStreet(page);
  for (const y of [-8, 24]) {
    await drag(-34, y, 76);
    await expect.poll(editor).toMatchObject({ pending: false });
  }
  await page.getByRole('button', { name: 'Pan' }).click();
  await page.mouse.move(0, 0);
  await page.evaluate(() => window.__towns!.setSpeed(120));
  // Each end of the extension and the four adjoining starter-road columns are painted.
  await expect.poll(() => page.evaluate(() => window.__towns!.town()!.households.filter(h => h.lot).length),
    { timeout: 200_000 }).toBe(21);
  await page.evaluate(() => window.__towns!.setSpeed(0));
  await page.screenshot({ path: 'artifacts/screens/growth-full-street.png' });
});

test('businesses grow beside homes on a mixed street', async ({ page }) => {
  test.setTimeout(160_000);
  const { at, drag, editor } = await connectedStreet(page);
  for (const [brush, start, y, end] of [['h', -34, -8, 76], ['s', -34, 24, 16], ['w', 18, 24, 76]] as const) {
    await page.keyboard.press(brush);
    await drag(start, y, end);
    await expect.poll(editor).toMatchObject({ pending: false });
  }
  await page.getByRole('button', { name: 'Pan' }).click();
  await page.mouse.move(0, 0);
  await page.evaluate(() => window.__towns!.setSpeed(120));
  const town = () => page.evaluate(() => window.__towns!.town()!);
  await expect.poll(async () => (await town()).businesses.some(b => b.zone === 'workplaces'), {timeout: 60_000}).toBe(true);
  await expect.poll(async () => (await town()).households.filter(h => h.lot).length, {timeout: 90_000}).toBeGreaterThan(3);
  await page.evaluate(() => window.__towns!.setSpeed(0));
  const shop = (await town()).businesses.find(b => b.zone === 'shops')!;
  await page.mouse.click(...at(shop.lot.x, shop.lot.y));
  await expect(page.getByRole('region', {name: 'Business'})).toContainText(shop.name);
  await page.screenshot({path: 'artifacts/screens/mixed-street.png'});
  await page.getByRole('region', {name: 'Zone demand'}).screenshot({path: 'artifacts/screens/zone-demand.png'});
});
