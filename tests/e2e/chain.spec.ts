import { expect, test, type Page } from '@playwright/test';
import { meadowTips } from '../../src/sim/scenarios/meadow';

const CHAIN_HINT = 'Click to place the next point. Click the last point or press Esc to finish.';
const MPP = 0.15;
const VIEW = { x: 0, y: 20 };

async function open(page: Page) {
  await page.goto(`/?speed=0&x=${VIEW.x}&y=${VIEW.y}&mpp=${MPP}`);
  const editor = () => page.evaluate(() => window.__towns?.editor());
  await expect.poll(editor).toMatchObject({ tool: 'road', pending: false, roadCount: 0 });
  const box = await page.locator('#map').boundingBox();
  if (!box) throw new Error('Missing map');
  const screen = (p: { x: number; y: number }) => ({
    x: box.x + box.width / 2 + (p.x - VIEW.x) / MPP,
    y: box.y + box.height / 2 - (p.y - VIEW.y) / MPP,
  });
  const move = (p: { x: number; y: number }) => page.mouse.move(screen(p).x, screen(p).y, { steps: 6 });
  const click = async (p: { x: number; y: number }) => {
    await move(p);
    await page.mouse.down();
    await page.mouse.up();
  };
  return { editor, move, click, screen, status: page.getByRole('status') };
}

test('click a road end, then click point after point to keep building the same street', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  const { editor, move, click, screen, status } = await open(page);
  const [west] = meadowTips([]);

  await click(west!);
  await expect.poll(editor).toMatchObject({ chaining: true, roadCount: 0, hint: CHAIN_HINT });
  await expect(page.getByText('Esc finishes')).toBeVisible();

  const points = [{ x: -10, y: -8 }, { x: 20, y: 6 }, { x: 50, y: 30 }];
  for (const [i, point] of points.entries()) {
    await move(point);
    await expect(status).toContainText(CHAIN_HINT);
    if (i === 1) await page.screenshot({ path: 'artifacts/screens/chain-preview.png' });
    await page.mouse.down();
    await page.mouse.up();
    await expect.poll(editor).toMatchObject({ roadCount: i + 1, chaining: true, pending: false, hint: CHAIN_HINT });
  }

  await click({ x: 20, y: 44 });
  await expect.poll(editor).toMatchObject({ roadCount: 4, chaining: true, pending: false, hint: CHAIN_HINT });
  await page.screenshot({ path: 'artifacts/screens/chain-corner.png' });
  await click({ x: 45, y: 38 });
  await expect.poll(editor).toMatchObject({ roadCount: 4, chaining: true, pending: false });
  await expect(status).toHaveText('That corner is too sharp. Turn by at most 120°.');
  await move({ x: -10, y: 58 });
  await expect(status).toContainText(CHAIN_HINT);

  const from = screen({ x: -10, y: 58 });
  await page.mouse.down({ button: 'right' });
  await page.mouse.move(from.x - 40, from.y + 30, { steps: 4 });
  await page.mouse.up({ button: 'right' });
  await expect.poll(editor).toMatchObject({ roadCount: 4, chaining: true });

  await page.keyboard.press('Escape');
  await expect.poll(editor).toMatchObject({ roadCount: 4, chaining: false, pending: false });
  await expect(page.getByText('Esc cancels')).toBeVisible();
  await page.screenshot({ path: 'artifacts/screens/chain-built.png' });
  expect(errors).toEqual([]);
});

test('a drag builds one road without chaining, and a chain ends where it joins a street', async ({ page }) => {
  const { editor, move, click, screen } = await open(page);
  const [west, east] = meadowTips([]);

  await move(west!);
  await page.mouse.down();
  await move({ x: -10, y: -8 });
  await page.mouse.up();
  await expect.poll(editor).toMatchObject({ roadCount: 1, chaining: false, pending: false });
  await move({ x: 20, y: 6 });
  await page.mouse.down();
  await page.mouse.up();
  await expect.poll(editor).toMatchObject({ roadCount: 1, chaining: true });
  await page.keyboard.press('Escape');
  await expect.poll(editor).toMatchObject({ roadCount: 1, chaining: false });

  await click({ x: -10, y: -8 });
  await expect.poll(editor).toMatchObject({ chaining: true });
  await click({ x: -10, y: -8 });
  await expect.poll(editor).toMatchObject({ roadCount: 1, chaining: false });

  await click({ x: -10, y: -8 });
  await click(east!);
  await expect.poll(editor).toMatchObject({ roadCount: 2, connected: true, chaining: false, pending: false });

  const tip = screen({ x: -10, y: -8 });
  await page.mouse.move(tip.x, tip.y);
  await page.mouse.down();
  await page.mouse.up();
  await expect.poll(editor).toMatchObject({ chaining: true });
  await page.getByRole('button', { name: 'Undo road' }).click();
  await expect.poll(editor).toMatchObject({ roadCount: 1, connected: false, chaining: false, pending: false });
});

test('toggling angle snap mid-chain redraws the preview without moving the pointer', async ({ page }) => {
  const { editor, move, click, status } = await open(page);
  const [west] = meadowTips([]);
  await click(west!);
  await expect.poll(editor).toMatchObject({ chaining: true });
  await move({ x: west!.x, y: west!.y + 28 });
  await expect(status).toContainText(`90° · ${CHAIN_HINT}`);
  const snap = page.getByRole('checkbox', { name: 'Angle snap' });
  await snap.uncheck();
  await expect(status).not.toContainText('90°');
  await snap.check();
  await expect(status).toContainText(`90° · ${CHAIN_HINT}`);
  await expect.poll(editor).toMatchObject({ chaining: true, roadCount: 0 });
});

test.describe('on a touch screen', () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true });

  test('tap a road end to start a chain, then tap Finish road', async ({ page }) => {
    const [west] = meadowTips([]);
    await page.goto(`/?speed=0&x=${west!.x}&y=${west!.y}&mpp=0.1`);
    const editor = () => page.evaluate(() => window.__towns?.editor());
    await expect.poll(editor).toMatchObject({ tool: 'road', pending: false });
    const box = await page.locator('#map').boundingBox();
    if (!box) throw new Error('Missing map');
    await page.touchscreen.tap(box.x + box.width / 2, box.y + box.height / 2);
    await expect.poll(editor).toMatchObject({ chaining: true, roadCount: 0 });
    const finish = page.getByRole('button', { name: 'Finish road' });
    await expect(finish).toBeVisible();
    await page.screenshot({ path: 'artifacts/screens/chain-finish-mobile.png' });
    await finish.tap();
    await expect.poll(editor).toMatchObject({ chaining: false, roadCount: 0, pending: false });
    await expect(finish).toBeHidden();
  });
});

test('a chain resumes with the preview at a pointer that moved while the road was building', async ({ page }) => {
  await page.addInitScript(() => {
    const held: (() => void)[] = [];
    const hold = window as unknown as { holdRoads: boolean; releaseRoads: () => void };
    hold.holdRoads = false;
    hold.releaseRoads = () => {
      hold.holdRoads = false;
      for (const deliver of held.splice(0)) deliver();
    };
    const onmessage = Object.getOwnPropertyDescriptor(Worker.prototype, 'onmessage')!;
    Object.defineProperty(Worker.prototype, 'onmessage', {
      ...onmessage,
      set(handler: (e: MessageEvent) => void) {
        onmessage.set!.call(this, (e: MessageEvent) => {
          if (hold.holdRoads && e.data?.type === 'roadsChanged') held.push(() => handler(e));
          else handler(e);
        });
      },
    });
  });
  const { editor, move, click, status } = await open(page);
  const [west] = meadowTips([]);
  await click(west!);
  await expect.poll(editor).toMatchObject({ chaining: true });
  await page.evaluate(() => { (window as unknown as { holdRoads: boolean }).holdRoads = true; });
  await click({ x: -10, y: west!.y });
  await expect.poll(editor).toMatchObject({ pending: true });
  await move({ x: -10, y: west!.y + 28 });
  await page.evaluate(() => (window as unknown as { releaseRoads: () => void }).releaseRoads());
  await expect.poll(editor).toMatchObject({ roadCount: 1, chaining: true, pending: false });
  await expect(status).toContainText(`90° · ${CHAIN_HINT}`);
});
