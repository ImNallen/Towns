import { expect, test, type Page } from '@playwright/test';

type View = { x: number; y: number; mpp: number };
/** The west starter street runs along y = -8; its north plots' back row is centred 32.5 m north of it. */
const BACK_ROW = 24.5;
const FRONT_ROW = 0.5;

async function open(page: Page, view: View, speed = 0) {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text());
  });
  await page.goto(`/?scenario=meadow&seed=1&speed=${speed}&x=${view.x}&y=${view.y}&mpp=${view.mpp}`);
  const editor = () => page.evaluate(() => window.__towns!.editor()!);
  await expect.poll(editor).toMatchObject({ tool: 'road', pending: false, roadCount: 0, zoned: 0 });
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
  const settled = () => expect.poll(editor).toMatchObject({ pending: false });
  const undo = async () => {
    await settled();
    await page.keyboard.press('Control+z');
    await settled();
  };
  return { editor, move, drag, settled, undo, errors };
}

const VIEW = { x: -100, y: 15, mpp: 0.14 };

test('paint plots beside a street and undo the stroke', async ({ page }) => {
  const { editor, drag, settled, undo, errors } = await open(page, VIEW);
  await page.keyboard.press('z');
  await expect.poll(editor).toMatchObject({ tool: 'zone', brush: 'residential' });
  await expect(page.getByRole('radio', { name: 'Residential' })).toBeChecked();
  await drag(-150, BACK_ROW, -70, BACK_ROW);
  await settled();
  const { zoned, hint, canUndo } = await editor();
  expect(zoned).toBeGreaterThan(30);
  expect(zoned % 4).toBe(0);
  expect(hint).toBe(`Zoned ${zoned} plots residential. Undo to remove them.`);
  expect(canUndo).toBe(true);
  await page.mouse.move(0, 0);
  await page.screenshot({ path: 'artifacts/screens/meadow-zone-paint.png' });
  await page.getByRole('button', { name: 'Pan' }).click();
  await page.screenshot({ path: 'artifacts/screens/meadow-zone-paint-no-grid.png' });
  await undo();
  await expect.poll(editor).toMatchObject({ zoned: 0, canUndo: false });
  expect(errors).toEqual([]);
});

test('a side street covers painted plots, bulldozing it uncovers them, the eraser clears them', async ({ page }) => {
  const { editor, move, drag, settled, undo, errors } = await open(page, VIEW);
  await page.getByRole('button', { name: 'Zone' }).click();
  await drag(-150, BACK_ROW, -50, BACK_ROW);
  await settled();
  const painted = (await editor()).zoned;
  expect(painted).toBeGreaterThan(40);

  await page.getByRole('button', { name: 'Build road', exact: true }).click();
  await drag(-65, 62, -65, -8);
  await expect.poll(editor).toMatchObject({ roadCount: 1, pending: false });
  const covered = (await editor()).zoned;
  expect(covered).toBeLessThan(painted);
  await page.mouse.move(0, 0);
  await page.screenshot({ path: 'artifacts/screens/meadow-zone-paint-covered.png' });

  await page.keyboard.press('b');
  await move(-65, 40);
  await page.mouse.down();
  await page.mouse.up();
  await expect.poll(editor).toMatchObject({ pending: false, zoned: painted });
  await page.mouse.move(0, 0);
  await page.screenshot({ path: 'artifacts/screens/meadow-zone-paint-uncovered.png' });

  await page.keyboard.press('z');
  await page.getByRole('radio', { name: 'Erase' }).click();
  await expect.poll(editor).toMatchObject({ tool: 'zone', brush: null });
  await drag(-150, FRONT_ROW, -120, FRONT_ROW);
  await settled();
  const erased = (await editor()).zoned;
  expect(erased).toBeLessThan(painted);
  expect((painted - erased) % 4).toBe(0);
  await page.mouse.move(0, 0);
  await page.screenshot({ path: 'artifacts/screens/meadow-zone-erase.png' });

  await undo();
  await expect.poll(editor).toMatchObject({ zoned: painted });
  await undo();
  await expect.poll(editor).toMatchObject({ zoned: covered, roadCount: 1 });
  await undo();
  await expect.poll(editor).toMatchObject({ zoned: painted, roadCount: 0 });
  await undo();
  await expect.poll(editor).toMatchObject({ zoned: 0, canUndo: false });
  expect(errors).toEqual([]);
});

test('a stroke previews exactly what it will zone, and Esc drops it', async ({ page }) => {
  const { editor, move, errors } = await open(page, VIEW);
  await page.keyboard.press('z');
  await move(-150, BACK_ROW);
  await page.mouse.down();
  await move(-110, BACK_ROW);
  await expect.poll(async () => (await editor()).hint).toMatch(/^Release to zone \d+ plots residential\.$/);
  const preview = Number((await editor()).hint.match(/\d+/)![0]);
  await page.screenshot({ path: 'artifacts/screens/meadow-zone-stroke-preview.png' });
  await page.keyboard.press('Escape');
  await page.mouse.up();
  await expect.poll(editor).toMatchObject({ canUndo: false, zoned: 0, pending: false });

  await move(-150, BACK_ROW);
  await page.mouse.down();
  await move(-110, BACK_ROW);
  await page.mouse.up();
  await expect.poll(editor).toMatchObject({ pending: false, zoned: preview });
  expect(errors).toEqual([]);
});

test('painting while cars drive never waits for traffic', async ({ page }) => {
  const { editor, drag, errors } = await open(page, VIEW, 4);
  await expect.poll(() => page.evaluate(() => window.__towns!.stats()?.active ?? 0), { timeout: 30_000 }).toBeGreaterThan(0);
  await page.keyboard.press('z');
  const before = await page.evaluate(() => window.__towns!.stats()!.completed);
  await drag(-150, BACK_ROW, -70, BACK_ROW);
  const states = await page.evaluate(() => new Promise<{ pending: boolean; canCancel: boolean }[]>((resolve) => {
    const seen: { pending: boolean; canCancel: boolean }[] = [];
    const sample = () => {
      const { pending, canCancel } = window.__towns!.editor()!;
      seen.push({ pending, canCancel });
      if (pending && seen.length < 200) requestAnimationFrame(sample);
      else resolve(seen);
    };
    sample();
  }));
  expect(states.at(-1)).toEqual({ pending: false, canCancel: false });
  expect(states.some((s) => s.canCancel)).toBe(false);
  expect((await editor()).zoned).toBeGreaterThan(30);
  expect(await page.evaluate(() => window.__towns!.stats()!.completed)).toBeGreaterThanOrEqual(before);
  expect(errors).toEqual([]);
});
