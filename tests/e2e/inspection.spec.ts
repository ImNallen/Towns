import { expect, test } from '@playwright/test';
import { meadowScenario } from '../../src/sim/scenarios/meadow';

for (const [device, viewport] of [
  ['desktop', { width: 1440, height: 900 }],
  ['phone', { width: 390, height: 844 }],
  ['landscape', { width: 844, height: 390 }],
  ['tablet', { width: 768, height: 1024 }],
] as const) {
  test.describe(device, () => {
    test.use({ viewport, hasTouch: device !== 'desktop' });
    test('budget stays anchored and the selected parcel stays clear of the HUD', async ({ page }) => {
      const house = meadowScenario().decor.houses[4]!;
      // Pick the parcel where the inspector will open, just above the collapsed budget.
      const mpp = 0.25;
      const x = house.x - (viewport.width * 0.4) * mpp;
      const y = house.y + (viewport.height * 0.24) * mpp;
      await page.goto(`/?speed=0&x=${x}&y=${y}&mpp=${mpp}`);
      const budget = page.locator('.budget');
      await expect(budget).toBeVisible();
      const initial = await budget.boundingBox();
      await page.evaluate(() => window.__towns!.selectHouse(4));
      await expect(page.getByRole('region', { name: 'Household' })).toBeVisible();
      const closed = await budget.boundingBox();
      expect(closed!.y + closed!.height).toBeCloseTo(initial!.y + initial!.height, 0);
      const obstructions = () => page.evaluate(() => {
        const selection = window.__towns!.selectedParcelOnScreen()!;
        const boxes = [{ name: 'Selected parcel', rect: selection }];
        for (const panel of document.querySelectorAll<HTMLElement>('.panel')) {
          const r = panel.getBoundingClientRect();
          // A scrollable rail clips its children to its own visible bounds.
          const rail = panel.closest<HTMLElement>('.hud-column.left');
          const clip = rail?.getBoundingClientRect();
          const bottom = clip ? Math.min(r.bottom, clip.bottom) : r.bottom;
          if (bottom > r.top) boxes.push({ name: panel.className, rect: new DOMRect(r.left, r.top, r.width, bottom - r.top) });
        }
        const collisions: string[] = [];
        for (const {name, rect} of boxes) {
          if (rect.left < 0 || rect.top < 0 || rect.right > innerWidth || rect.bottom > innerHeight) collisions.push(name + ' outside viewport');
        }
        for (let a = 0; a < boxes.length; a++) for (let b = a + 1; b < boxes.length; b++) {
          const left = boxes[a]!, right = boxes[b]!;
          if (left.rect.left < right.rect.right && left.rect.right > right.rect.left &&
              left.rect.top < right.rect.bottom && left.rect.bottom > right.rect.top) {
            collisions.push(left.name + ' overlaps ' + right.name);
          }
        }
        return collisions;
      });
      await expect.poll(obstructions).toEqual([]);
      await budget.locator('summary').click();
      await expect(budget).toHaveAttribute('open', '');
      await expect.poll(obstructions).toEqual([]);
      if (device === 'phone' || device === 'desktop') await page.screenshot({ path: `artifacts/screens/inspection-budget-${device}.png` });
      await budget.locator('summary').click();
      await page.getByRole('button', { name: 'Close household' }).click();
      await expect(page.getByRole('region', { name: 'Household' })).toBeHidden();
    });
  });
}
