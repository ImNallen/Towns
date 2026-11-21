import { expect, test, type Page } from '@playwright/test';

type View = { x: number; y: number; mpp: number };

async function open(page: Page, view: View) {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text());
  });
  await page.goto(`/?scenario=meadow&seed=1&speed=0&zones=1&x=${view.x}&y=${view.y}&mpp=${view.mpp}`);
  const editor = () => page.evaluate(() => window.__towns?.editor());
  await expect.poll(editor).toMatchObject({ tool: 'road', pending: false, roadCount: 0 });
  const box = await page.locator('#map').boundingBox();
  if (!box) throw new Error('Missing map');
  const move = (x: number, y: number) => page.mouse.move(
    box.x + box.width / 2 + (x - view.x) / view.mpp, box.y + box.height / 2 - (y - view.y) / view.mpp, { steps: 6 },
  );
  const drag = async (x: number, y: number, endX: number, endY: number) => {
    await move(x, y);
    await page.mouse.down();
    await move(endX, endY);
    await page.mouse.up();
  };
  return { editor, move, drag, errors };
}

test('zone cells line the starter streets', async ({ page }) => {
  const { errors } = await open(page, { x: 0, y: 0, mpp: 0.27 });
  await page.screenshot({ path: 'artifacts/screens/meadow-zones.png' });
  await page.goto('/?scenario=meadow&seed=1&speed=0&zones=1&x=-110&y=0&mpp=0.1');
  await expect.poll(() => page.evaluate(() => window.__towns?.editor())).toMatchObject({ pending: false });
  await page.screenshot({ path: 'artifacts/screens/meadow-zones-west.png' });
  expect(errors).toEqual([]);
});

test('a T-junction carves its mouth out of the zone cells', async ({ page }) => {
  const { editor, drag, errors } = await open(page, { x: -65, y: 20, mpp: 0.1 });
  await drag(-65, 62, -65, -8);
  await expect.poll(editor).toMatchObject({ roadCount: 1, pending: false });
  await page.mouse.move(0, 0);
  await page.screenshot({ path: 'artifacts/screens/meadow-zones-t-junction.png' });
  expect(errors).toEqual([]);
});

test('zone cells fan out around a curved road', async ({ page }) => {
  const { editor, move, drag, errors } = await open(page, { x: 0, y: 35, mpp: 0.18 });
  await page.getByRole('button', { name: 'Build curved road' }).click();
  await drag(-65, -8, 65, 8);
  await move(0, 85);
  await page.mouse.down();
  await page.mouse.up();
  await expect.poll(editor).toMatchObject({ roadCount: 1, connected: true, pending: false });
  await page.mouse.move(0, 0);
  await page.screenshot({ path: 'artifacts/screens/meadow-zones-curve.png' });
  await move(0, 62);
  await page.mouse.wheel(0, -500);
  await page.mouse.move(0, 0);
  await page.screenshot({ path: 'artifacts/screens/meadow-zones-curve-inside.png' });
  expect(errors).toEqual([]);
});
