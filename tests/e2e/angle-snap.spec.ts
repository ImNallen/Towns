import { expect, test } from '@playwright/test';

test('the snapped and free previews build at their respective endpoints', async ({ page }) => {
  await page.goto('/?speed=0&x=-45&y=30&mpp=0.22');
  const editor = () => page.evaluate(() => window.__towns?.editor());
  await expect.poll(editor).toMatchObject({ pending: false });
  const box = await page.locator('#map').boundingBox();
  if (!box) throw new Error('Missing map');
  const move = (x: number, y: number) => page.mouse.move(
    box.x + box.width / 2 + (x + 45) / 0.22,
    box.y + box.height / 2 - (y - 30) / 0.22,
  );
  const status = page.getByRole('status');
  const toggle = page.getByRole('checkbox', { name: 'Angle snap' });
  await expect(toggle).toBeChecked();

  for (const snapping of [true, false]) {
    if (!snapping) await toggle.uncheck();
    await move(-65, -8);
    await page.mouse.down();
    await move(-56, 50);
    await expect(status).toHaveText('Release to extend the street.');
    await move(-59, 67);
    await expect(status).toHaveText(snapping ? '90° · Release to extend the street.' : 'Release to extend the street.');
    if (snapping) {
      await page.screenshot({ path: 'artifacts/screens/meadow-angle-snap.png' });
      await toggle.focus();
      await page.keyboard.press('Space');
      await expect(status).toHaveText('Release to extend the street.');
      await page.keyboard.press('Space');
      await expect(status).toContainText('90°');
    }
    await page.mouse.up();
    await expect.poll(editor).toMatchObject({ roadCount: 1, pending: false });

    await move(snapping ? -59 : -65, 67);
    await page.mouse.down();
    await expect(status).toHaveText('Drag across an existing street to build a crossing.');
    await page.mouse.up();
    await move(snapping ? -65 : -59, 67);
    await page.mouse.down();
    await expect(status).toHaveText('Drag to the other end of your new road.');
    await page.mouse.up();
    await page.getByRole('button', { name: 'Undo road' }).click();
    await expect.poll(editor).toMatchObject({ roadCount: 0, pending: false });
  }
});

test('slide the cross street into alignment at both ends and run traffic through the turns', async ({ page }) => {
  await page.goto('/?speed=0&x=0&y=40&mpp=0.24');
  const editor = () => page.evaluate(() => window.__towns?.editor());
  await expect.poll(editor).toMatchObject({ pending: false });
  const box = await page.locator('#map').boundingBox();
  if (!box) throw new Error('Missing map');
  const move = (x: number, y: number) => page.mouse.move(
    box.x + box.width / 2 + x / 0.24, box.y + box.height / 2 - (y - 40) / 0.24,
  );
  const status = page.getByRole('status');
  await move(-65, -8);
  await page.mouse.down();
  await move(-24, 31);
  await expect(status).toContainText('45°');
  await move(-61, 82);
  await expect(status).toContainText('90°');
  await page.mouse.up();
  await expect.poll(editor).toMatchObject({ roadCount: 1 });

  await move(65, 8);
  await page.mouse.down();
  await move(63, 83);
  await expect(status).toContainText('90°');
  await page.mouse.up();
  await expect.poll(editor).toMatchObject({ roadCount: 2 });

  await move(-65, 28);
  await page.mouse.down();
  await move(65, 61);
  await expect(status).toHaveText('Release to connect the streets.');
  await page.keyboard.press('Escape');
  await page.mouse.up();

  await move(-65, 46);
  await page.mouse.down();
  await move(58, 66);
  const squareHint = '90° at both ends · Release to connect the streets.';
  await expect(status).toHaveText(squareHint);
  await move(65, 66);
  await page.getByRole('checkbox', { name: 'Angle snap' }).focus();
  await page.keyboard.press('Space');
  await expect(status).toHaveText('Release to connect the streets.');
  await page.keyboard.press('Space');
  await expect(status).toHaveText(squareHint);
  await page.screenshot({ path: 'artifacts/screens/meadow-side-connection.png' });
  await page.mouse.up();
  await expect.poll(editor).toMatchObject({ roadCount: 3, connected: true });

  await move(65, 46);
  await page.mouse.down();
  await move(100, 46);
  await expect(status).toHaveText('Straight · Release to build a four-way intersection.');
  await page.keyboard.press('Escape');
  await page.mouse.up();
  await page.getByRole('button', { name: '8× speed' }).click();
  await expect.poll(() => page.evaluate(() => window.__towns?.stats()?.completed ?? 0), { timeout: 30_000 }).toBeGreaterThan(0);
});
