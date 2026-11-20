import { expect, test } from '@playwright/test';
import { meadowScenario, meadowTips } from '../../src/sim/scenarios/meadow';

test('build a street, see a completed trip, and undo the connection', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto('/?speed=0');
  const editor = () => page.evaluate(() => window.__towns?.editor());
  await expect.poll(editor).toMatchObject({ tool: 'road', pending: false, connected: false, roadCount: 0 });
  const box = await page.locator('#map').boundingBox();
  if (!box) throw new Error('Map canvas is missing');
  const b = meadowScenario().bounds;
  const mpp = Math.max((b.maxX - b.minX) / box.width, (b.maxY - b.minY) / box.height) * 0.95;
  const [west, east] = meadowTips([]).map((tip) => ({
    x: box.x + box.width / 2 + (tip.x - (b.minX + b.maxX) / 2) / mpp,
    y: box.y + box.height / 2 - (tip.y - (b.minY + b.maxY) / 2) / mpp,
  }));
  await page.screenshot({ path: 'artifacts/screens/meadow.png' });

  await page.getByRole('button', { name: 'Pan', exact: true }).click();
  await expect.poll(editor).toMatchObject({ tool: 'pan' });
  await page.getByRole('button', { name: 'Build road', exact: true }).click();
  await page.mouse.move(west.x, west.y);
  await page.mouse.down();
  await page.mouse.move(east.x, east.y, { steps: 8 });
  await expect.poll(editor).toMatchObject({ hint: 'Release to connect the streets.' });
  await expect(page.getByRole('status')).toHaveText('Release to connect the streets.');
  await page.screenshot({ path: 'artifacts/screens/meadow-preview.png' });
  await page.keyboard.press('Escape');
  await page.mouse.up();
  await expect.poll(editor).toMatchObject({ connected: false, roadCount: 0 });

  await page.mouse.move(west.x, west.y);
  await page.mouse.down();
  await page.mouse.move(west.x - 55, west.y);
  await page.mouse.up();
  await expect.poll(editor).toMatchObject({ roadCount: 0, hint: expect.stringMatching(/.+/) });

  await page.mouse.move(east.x, east.y);
  await page.mouse.down();
  await page.mouse.move(west.x + 5, west.y + 4, { steps: 5 });
  await page.mouse.up();
  await expect.poll(editor).toMatchObject({ roadCount: 1, connected: true });
  await expect.poll(() => page.evaluate(() => window.__towns?.stats()?.tick)).toEqual(0);
  await page.keyboard.press('4');
  await expect.poll(() => page.evaluate(() => window.__towns?.stats()?.completed ?? 0), { timeout: 40_000 }).toBeGreaterThan(0);
  await page.screenshot({ path: 'artifacts/screens/meadow-traffic.png' });
  await page.mouse.move((west.x + east.x) / 2, (west.y + east.y) / 2);
  await page.mouse.wheel(0, -550);
  await page.screenshot({ path: 'artifacts/screens/meadow-joins.png' });

  await page.getByRole('button', { name: 'Undo road', exact: true }).click();
  await expect.poll(editor, { timeout: 30_000 }).toMatchObject({ roadCount: 0, connected: false });
  const stats = await page.evaluate(() => window.__towns?.stats());
  expect(stats?.completed).toBeGreaterThan(0);
  await expect.poll(() => page.evaluate(() => window.__towns?.stats()?.active), { timeout: 15_000 }).toBe(0);
  expect(stats?.tick).toBeGreaterThan(0);
  expect(errors).toEqual([]);
});

test.describe('touch controls', () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true });

  test('shape a street in sections on a small touch screen', async ({ page }) => {
    await page.goto('/?speed=0&x=0&y=0&mpp=0.75');
    const editor = () => page.evaluate(() => window.__towns?.editor());
    await expect.poll(editor).toMatchObject({ pending: false, roadCount: 0 });
    const touch = await page.context().newCDPSession(page);
    const drag = async (a: { x: number; y: number }, b: { x: number; y: number }) => {
      const screen = (p: typeof a) => ({ x: 195 + p.x / 0.75, y: 422 - p.y / 0.75 });
      await touch.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [screen(a)] });
      await touch.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [screen(b)] });
      await touch.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    };
    const [west, east] = meadowTips([]);
    const middle = { x: -7, y: 1 };
    await drag(west, middle);
    await expect.poll(editor).toMatchObject({ roadCount: 1, connected: false });
    await drag(middle, east);
    await expect.poll(editor).toMatchObject({ roadCount: 2, connected: true });
    await page.screenshot({ path: 'artifacts/screens/meadow-mobile.png' });
    await page.getByRole('button', { name: 'Undo road', exact: true }).tap();
    await expect.poll(editor).toMatchObject({ roadCount: 1, connected: false });
  });
});

test('cancel a deferred undo without removing the road or its traffic', async ({ page }) => {
  await page.goto('/?speed=0&x=0&y=0&mpp=0.5');
  const editor = () => page.evaluate(() => window.__towns?.editor());
  await expect.poll(editor).toMatchObject({ pending: false });
  const box = await page.locator('#map').boundingBox();
  if (!box) throw new Error('Missing map');
  const [west, east] = meadowTips([]);
  const move = (tip: typeof west) => page.mouse.move(box.x + box.width / 2 + tip.x * 2, box.y + box.height / 2 - tip.y * 2);
  await move(west);
  await page.mouse.down();
  await move(east);
  await page.mouse.up();
  await expect.poll(editor).toMatchObject({ connected: true });
  await page.keyboard.press('4');
  await expect.poll(() => stat('active')).toBeGreaterThan(1);
  await page.getByRole('button', { name: 'Pause simulation' }).click();
  const active = await stat('active');
  await page.getByRole('button', { name: 'Undo road' }).click();
  await expect(page.getByRole('button', { name: 'Resume traffic' })).toBeVisible();
  await page.getByRole('button', { name: 'Cancel edit' }).click();
  await expect.poll(editor).toMatchObject({ pending: false, connected: true, roadCount: 1 });
  expect(await stat('active')).toBe(active);
  await page.keyboard.press('4');
  await expect.poll(() => stat('completed'), { timeout: 20_000 }).toBeGreaterThan(0);

  function stat(key: 'active' | 'completed') {
    return page.evaluate((name) => window.__towns?.stats()?.[name] ?? 0, key);
  }
});
