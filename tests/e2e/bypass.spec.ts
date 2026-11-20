import { expect, test } from '@playwright/test';

test('shape a winding route and build a bypass under live traffic', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('worker', (worker) => worker.on('close', () => errors.push('Simulation worker closed')));
  await page.goto('/?speed=0&x=0&y=20&mpp=0.3');
  const editor = () => page.evaluate(() => window.__towns?.editor());
  const stats = () => page.evaluate(() => window.__towns?.stats());
  await expect.poll(editor).toMatchObject({ pending: false });
  const box = await page.locator('#map').boundingBox();
  if (!box) throw new Error('Missing map');
  const move = (x: number, y: number, steps = 1) => page.mouse.move(
    box.x + box.width / 2 + x / 0.3, box.y + box.height / 2 - (y - 20) / 0.3, { steps },
  );
  const drag = async (x: number, y: number, endX: number, endY: number) => {
    await move(x, y);
    await page.mouse.down();
    await move(endX, endY, 6);
    await page.mouse.up();
  };

  await page.getByRole('button', { name: 'Build curved road' }).click();
  await drag(-65, -8, 65, 8);
  await expect(page.getByRole('status')).toContainText('place', { ignoreCase: true });
  await move(0, 85);
  await expect.poll(editor).toMatchObject({ canCancel: true });
  await page.mouse.down();
  await page.mouse.up();
  await expect.poll(editor).toMatchObject({ roadCount: 1, connected: true });
  await page.getByRole('button', { name: '8× speed' }).click();
  await expect.poll(async () => (await stats())?.active ?? 0).toBeGreaterThan(1);
  const before = await stats();

  await page.getByRole('button', { name: 'Build road', exact: true }).click();
  await drag(-47.27, 27.85, 52.30, 27.74);
  await expect.poll(editor, { timeout: 20_000 }).toMatchObject({ roadCount: 2, connected: true });
  expect((await stats())!.spawned).toBeGreaterThanOrEqual(before!.spawned);
  await expect.poll(async () => (await stats())?.completed ?? 0, { timeout: 30_000 }).toBeGreaterThan(2);
  await page.screenshot({ path: 'artifacts/screens/meadow-bypass.png' });
  await move(-47.27, 27.85);
  await page.mouse.wheel(0, -640);
  await page.screenshot({ path: 'artifacts/screens/meadow-t-junction.png' });
  await page.keyboard.press('l');
  await page.screenshot({ path: 'artifacts/screens/meadow-t-junction-lanes.png' });
  await page.getByRole('button', { name: 'Undo road' }).click();
  await expect.poll(editor, { timeout: 30_000 }).toMatchObject({ roadCount: 1, connected: true });
  expect((await stats())!.lost).toBe(0);
  expect(errors).toEqual([]);
});
