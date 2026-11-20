import { expect, test } from '@playwright/test';
import type { Vec2 } from '../../src/sim/math/vec';
import { meadowScenario, meadowTips } from '../../src/sim/scenarios/meadow';

test('residents commute, a household card opens on click, and a new road sends the west to Eastford', async ({ page }) => {
  test.setTimeout(180_000);
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text());
  });
  await page.goto('/?speed=8');
  const town = () => page.evaluate(() => window.__towns?.town() ?? null);
  const selected = () => page.evaluate(() => window.__towns?.selectedHouse() ?? null);
  const box = await page.locator('#map').boundingBox();
  if (!box) throw new Error('Map canvas is missing');
  const scenario = meadowScenario();
  const b = scenario.bounds;
  const mpp = Math.max((b.maxX - b.minX) / box.width, (b.maxY - b.minY) / box.height) * 0.95;
  const screen = (p: Vec2) => ({
    x: box.x + box.width / 2 + (p.x - (b.minX + b.maxX) / 2) / mpp,
    y: box.y + box.height / 2 - (p.y - (b.minY + b.maxY) / 2) / mpp,
  });
  const click = async (p: Vec2) => {
    const at = screen(p);
    await page.mouse.click(at.x, at.y);
  };
  const residents = page.getByRole('region', { name: 'Residents' });
  const card = page.getByRole('region', { name: 'Household' });

  await expect(residents).toContainText('12 homes');
  await expect(residents.getByRole('definition').first()).toHaveText('37');
  await expect(page.locator('.clock')).toHaveText(/^Day 1 · \d\d:\d\d$/);
  // A resident is on the road exactly while their car is.
  await expect.poll(async () => (await town())?.households.flatMap((h) => h.members).some((m) => m.activity === 'outbound'), { timeout: 30_000 }).toBe(true);
  await page.screenshot({ path: 'artifacts/screens/town-overview.png' });

  await click(scenario.decor.houses[3]!);
  await expect.poll(selected).toBe(3);
  await expect(card.getByRole('heading')).toHaveText(/^The \w+$/);
  await expect(card).toContainText('Happiness');
  await expect(card.getByRole('listitem')).toHaveCount((await town())!.households[3]!.members.length);
  await page.screenshot({ path: 'artifacts/screens/town-household.png' });
  await page.keyboard.press('Escape');
  await expect(card).toBeHidden();
  expect(await selected()).toBeNull();

  await page.getByRole('button', { name: 'Pan', exact: true }).click();
  await click(scenario.decor.houses[8]!);
  await expect.poll(selected).toBe(8);
  await click({ x: 0, y: -60 });
  await expect.poll(selected).toBeNull();

  const [westTip, eastTip] = meadowTips([]).map(screen);
  await page.getByRole('button', { name: 'Build road', exact: true }).click();
  await page.mouse.move(eastTip!.x, eastTip!.y);
  await page.mouse.down();
  await page.mouse.move(westTip!.x + 5, westTip!.y + 4, { steps: 5 });
  await page.mouse.up();
  await expect.poll(() => page.evaluate(() => window.__towns?.editor()?.connected)).toBe(true);

  // Jobs change hands at midnight, so run through the night and watch the next morning's commute.
  await page.evaluate(() => window.__towns?.setSpeed(60));
  await expect.poll(async () => {
    const t = await town();
    return t !== null && t.day >= 2 && t.minuteOfDay >= 7 * 60 + 15;
  }, { timeout: 90_000 }).toBe(true);
  await page.getByRole('button', { name: '8× speed' }).click();
  // Everyone bound for Eastford leaves along the east street.
  await expect.poll(async () => (await town())?.households.flatMap((h) => h.members).filter((m) => m.activity === 'outbound' && m.place === 'Eastford').length ?? 0).toBeGreaterThan(2);
  const street = screen({ x: 120, y: 8 });
  await page.mouse.move(street.x, street.y);
  await page.mouse.wheel(0, -450);
  await page.screenshot({ path: 'artifacts/screens/town-cars.png' });
  await page.mouse.wheel(0, 450);
  const commuter = (await town())!.households.find((h) => h.region === 'Westbrook' && h.members.some((m) => m.job === 'Eastford'));
  expect(commuter).toBeDefined();
  expect((await town())!.events.some((e) => (e.kind === 'changedJob' || e.kind === 'newJob') && e.region === 'Eastford' && e.day === 2)).toBe(true);
  await expect(residents.getByRole('listitem')).toHaveCount(3);
  await expect.poll(async () => (await town())?.totals.crossCommuters ?? 0).toBeGreaterThan(0);
  await click(scenario.decor.houses[commuter!.home]!);
  await expect.poll(selected).toBe(commuter!.home);
  await expect(card).toContainText('Works in Eastford');
  await page.waitForTimeout(1500);
  await page.screenshot({ path: 'artifacts/screens/town-cross-commute.png' });

  const upgraded = (await town())!.households.find((h) => h.level > 1);
  if (upgraded) {
    await click(scenario.decor.houses[upgraded.home]!);
    const at = screen(scenario.decor.houses[upgraded.home]!);
    await page.mouse.move(at.x, at.y);
    await page.mouse.wheel(0, -500);
    await page.screenshot({ path: 'artifacts/screens/town-upgraded-house.png' });
  }

  expect((await page.evaluate(() => window.__towns?.stats()))?.lost).toBe(0);
  expect(errors).toEqual([]);
});

test.describe('on a phone', () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true });

  test('the household card fits above the toolbar', async ({ page }) => {
    await page.goto('/?speed=8');
    await expect(page.getByRole('region', { name: 'Residents' })).toContainText('people');
    await page.evaluate(() => window.__towns?.selectHouse(4));
    const card = page.getByRole('region', { name: 'Household' });
    await expect(card).toBeVisible();
    const cardBox = await card.boundingBox();
    const toolbar = await page.getByRole('group', { name: 'Map tools' }).boundingBox();
    expect(cardBox!.y + cardBox!.height).toBeLessThanOrEqual(toolbar!.y);
    expect(cardBox!.y).toBeGreaterThanOrEqual(0);
    await page.screenshot({ path: 'artifacts/screens/town-household-mobile.png' });
  });
});
