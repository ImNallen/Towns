import { expect, test } from '@playwright/test';

test('cross a live street in one drag, undo it, and extend a T through the same junction', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto('/?speed=0&x=-35&y=0&mpp=0.2');
  const editor = () => page.evaluate(() => window.__towns?.editor());
  const stats = () => page.evaluate(() => window.__towns?.stats());
  await expect.poll(editor).toMatchObject({ tool: 'road', pending: false });
  const box = await page.locator('#map').boundingBox();
  if (!box) throw new Error('Missing map');
  const move = (x: number, y: number) => page.mouse.move(
    box.x + box.width / 2 + (x + 35) / 0.2, box.y + box.height / 2 - y / 0.2,
  );
  const drag = async (x: number, y: number, endX: number, endY: number) => {
    await move(x, y);
    await page.mouse.down();
    await move(endX, endY);
  };
  await drag(-45, -8, 45, 8);
  await page.mouse.up();
  await expect.poll(editor).toMatchObject({ roadCount: 1, connected: true });
  await page.getByRole('button', { name: '8× speed' }).click();
  await expect.poll(async () => (await stats())?.active ?? 0).toBeGreaterThan(1);
  await drag(-65, -48, -63, 48);
  await expect(page.getByRole('status')).toHaveText('90° · Release to build a four-way intersection.');
  await page.screenshot({ path: 'artifacts/screens/meadow-four-way-preview.png' });
  await page.mouse.up();
  await expect.poll(editor, { timeout: 20_000 }).toMatchObject({ roadCount: 2, connected: true });
  const arrived = (await stats())!.completed;
  await expect.poll(async () => (await stats())!.completed, { timeout: 30_000 }).toBeGreaterThan(arrived);
  await page.screenshot({ path: 'artifacts/screens/meadow-four-way.png' });
  await page.getByRole('button', { name: 'Undo' }).click();
  await expect.poll(editor, { timeout: 20_000 }).toMatchObject({ roadCount: 1, connected: true });
  await drag(-65, -8, -65, 48);
  await page.mouse.up();
  await expect.poll(editor, { timeout: 20_000 }).toMatchObject({ roadCount: 2 });
  await drag(-64, -7, -64, -48);
  await expect(page.getByRole('status')).toHaveText('Straight · Release to build a four-way intersection.');
  await page.mouse.up();
  await expect.poll(editor, { timeout: 20_000 }).toMatchObject({ roadCount: 3, connected: true });
  await page.getByRole('button', { name: 'Undo' }).click();
  await expect.poll(editor, { timeout: 20_000 }).toMatchObject({ roadCount: 2, connected: true });
  expect((await stats())!.lost).toBe(0);
  expect(errors).toEqual([]);
});
