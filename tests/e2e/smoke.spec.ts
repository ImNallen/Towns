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

test('mixed vehicles share the road between the neighbourhoods', async ({ page }) => {
  const mpp = 0.15;
  await page.goto('/?scenario=meadow&seed=1&speed=0&x=15&y=0&mpp=0.15');
  await expect.poll(() => page.evaluate(() => window.__towns?.editor()?.pending)).toBe(false);
  const box = (await page.locator('#map').boundingBox())!;
  const at = (x: number, y: number) =>
    [box.x + box.width / 2 + (x - 15) / mpp, box.y + box.height / 2 - y / mpp] as const;
  await page.mouse.move(...at(45, 8));
  await page.mouse.down();
  await page.mouse.move(...at(-45, -8), { steps: 16 });
  await page.mouse.up();
  await expect.poll(() => page.evaluate(() => window.__towns?.editor()?.connected)).toBe(true);
  await page.getByRole('button', { name: 'Pan', exact: true }).click();
  await page.mouse.move(0, 0);
  await page.evaluate(() => window.__towns!.setSpeed(120));
  await page.waitForFunction(() => {
    if ((window.__towns!.stats()?.active ?? 0) < 18) return false;
    window.__towns!.setSpeed(0);
    return true;
  });
  await page.screenshot({path: 'artifacts/screens/mixed-vehicles.png'});
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
  await expect(page.locator('figure canvas')).toHaveCount(42);
  await page.locator('#vehicles').screenshot({ path: 'artifacts/screens/vehicle-catalogue.png' });
  await page.locator('#roads').screenshot({ path: 'artifacts/screens/road-catalogue.png' });
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

async function connectedStreet(page: Page, query = '', connect = false) {
  await page.goto('/?scenario=meadow&seed=1&speed=0&x=20&y=8&mpp=0.15' + query);
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
  if (connect) {
    await page.mouse.move(...at(45,8));
    await page.mouse.down();
    await page.mouse.move(...at(-45,-8),{steps:16});
    await page.mouse.up();
  } else await drag(45, 8, -35);
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
  await page.keyboard.press('Escape');
  await page.evaluate(() => window.__towns!.setSpeed(120));
  await expect.poll(async () => (await town()).day, {timeout: 100_000}).toBeGreaterThanOrEqual(4);
  await page.evaluate(() => window.__towns!.setSpeed(0));
  await page.locator('.budget summary').click();
  await expect(page.locator('.budget')).toContainText('Day 3');
  await page.screenshot({path: 'artifacts/screens/budget-day-four.png'});
  await page.evaluate(() => window.__towns!.setSpeed(120));
  await expect.poll(async () => (await town()).budget.today.homes, {timeout: 45_000}).toBeGreaterThan(0);
  await page.evaluate(() => window.__towns!.setSpeed(0));
  await expect(page.locator('.budget')).toContainText('settle at midnight');
  await page.screenshot({path: 'artifacts/screens/budget-accrual.png'});
  await page.locator('.budget summary').click();
  // Pause in the browser as soon as a delivery is unloading, before the next worker frame.
  await page.evaluate(() => window.__towns!.setSpeed(40));
  await page.waitForFunction(() => {
    if (!window.__towns!.town()!.businesses.some(b => b.zone === 'workplaces' && b.unloading)) return false;
    window.__towns!.setSpeed(0);
    return true;
  }, null, { timeout: 90_000, polling: 'raf' });
  await page.screenshot({path: 'artifacts/screens/workplace-lorry.png'});

});

test('road quote, salvage and insufficient funds agree with the HUD', async ({ page }) => {
  await page.goto('/?scenario=meadow&seed=1&speed=0&x=0&y=0&mpp=0.24');
  const balance = () => page.evaluate(() => window.__towns?.town()?.budget.balance);
  await expect.poll(balance).toBe(6000);
  const box = (await page.locator('#map').boundingBox())!;
  const at = (x: number, y: number) =>
    [box.x + box.width / 2 + x / 0.24, box.y + box.height / 2 - y / 0.24] as const;
  for (let attempt = 0; attempt < 20; attempt++) {
    const before = (await balance())!;
    await page.keyboard.press('r');
    await page.mouse.move(...at(45, 8));
    await page.mouse.down();
    await page.mouse.move(...at(-45, -8), { steps: 8 });
    if (attempt === 0) {
      await expect(page.locator('.preview-cost')).toContainText('Costs $');
      await page.screenshot({path: 'artifacts/screens/budget-road-quote.png'});
    }
    await expect(page.locator('.preview-cost, [role=status]').filter({hasText: /Costs \$/}).first()).toBeVisible();
    if (await page.evaluate(() => window.__towns!.editor()!.hint.includes('you have'))) {
      await page.screenshot({path: 'artifacts/screens/budget-refused.png'});
      await page.mouse.up();
      await expect(page.getByRole('status')).toContainText('you have');
      expect(await balance()).toBe(before);
      return;
    }
    await page.mouse.up();
    await expect.poll(balance).toBeLessThan(before);
    const built = (await balance())!;
    await page.keyboard.press('b');
    await page.mouse.click(...at(0, 0));
    await expect.poll(balance).toBeGreaterThan(built);
  }
  throw new Error('Repeated construction and salvage should exhaust the budget');
});

test('rear gardens and service yards on a mature mixed street', async ({ page }) => {
  test.setTimeout(200_000);
  const { drag, editor } = await connectedStreet(page);
  for (const [brush, start, end, sign] of [['h', -34, 76, -1], ['s', -34, 16, 1], ['w', 18, 76, 1]] as const) {
    await page.keyboard.press(brush);
    for (const offset of [8, 16, 24, 32]) {
      await drag(start, 8 + sign * offset, end);
      await expect.poll(editor).toMatchObject({ pending: false });
    }
  }
  await page.getByRole('button', { name: 'Pan' }).click();
  await page.mouse.move(0, 0);
  await page.evaluate(() => window.__towns!.setSpeed(480));
  await expect.poll(() => page.evaluate(() => window.__towns!.town()!.day), {timeout: 180_000}).toBeGreaterThanOrEqual(10);
  await page.evaluate(() => window.__towns!.setSpeed(0));
  await page.screenshot({path: 'artifacts/screens/mature-mixed.png'});
});

test('erasing a rear row updates the occupied garden while paused', async ({ page }) => {
  const { at, editor } = await connectedStreet(page);
  const rear = at(2, -24);
  await page.mouse.click(...rear);
  await expect.poll(editor).toMatchObject({ pending: false, zoned: 4 });
  await page.getByRole('button', { name: 'Pan' }).click();
  await page.evaluate(() => window.__towns!.setSpeed(120));
  await expect.poll(() => page.evaluate(() => window.__towns!.town()!.households.some(h => h.lot)), { timeout: 30_000 }).toBe(true);
  await page.evaluate(() => window.__towns!.setSpeed(0));
  await page.mouse.click(...rear);
  const household = page.getByRole('region', { name: 'Household' });
  await expect(household).toBeVisible();
  await page.keyboard.press('Escape');
  await page.keyboard.press('z');
  await page.getByRole('radio', { name: 'Erase' }).click();
  await page.mouse.click(...rear);
  await expect.poll(editor).toMatchObject({ pending: false, zoned: 3 });
  await page.getByRole('button', { name: 'Pan' }).click();
  await page.mouse.click(...rear);
  expect(await page.evaluate(() => window.__towns!.selectedHouse())).toBeNull();
});

test('road type preview, upgrades and residential growth', async ({ page }) => {
  test.setTimeout(120_000);
  const { at, drag, editor } = await connectedStreet(page);
  await page.keyboard.press('r');
  await page.keyboard.press('7');
  await page.mouse.move(...at(0, 8));
  await page.mouse.down();
  await page.mouse.move(...at(0, 49), { steps: 10 });
  await expect(page.locator('.preview-cost')).toContainText('Costs');
  await page.screenshot({ path: 'artifacts/screens/road-type-preview.png' });
  await page.keyboard.press('5');
  await expect.poll(editor).toMatchObject({ roadType: 'country' });
  await page.mouse.up();
  await expect.poll(editor).toMatchObject({ roadCount: 2, pending: false });
  await page.keyboard.press('u');
  await page.keyboard.press('7');
  const balance = () => page.evaluate(() => window.__towns!.town()!.budget.balance);
  const before = await balance();
  await page.mouse.click(...at(13, 8));
  await expect.poll(balance).toBeLessThan(before);
  await page.keyboard.press('z');
  await drag(12, -8, 42);
  await expect.poll(async () => (await editor())!.zoned).toBeGreaterThan(5);
  await page.keyboard.press('v');
  await page.mouse.move(0, 0);
  await page.screenshot({ path: 'artifacts/screens/road-types-map.png' });
  await page.evaluate(() => window.__towns!.setSpeed(240));
  await expect.poll(() => page.evaluate(() => window.__towns!.town()!.households.filter(h => h.lot).length), { timeout: 90_000 }).toBeGreaterThanOrEqual(3);
  await page.evaluate(() => window.__towns!.setSpeed(0));
  await page.screenshot({ path: 'artifacts/screens/road-upgrade-growth.png' });
});

test('parking occupancy and a new lot serving the shops', async ({ page }) => {
  test.setTimeout(150_000);
  const { at, drag, editor } = await connectedStreet(page, '&walkLimit=0');
  await page.keyboard.press('s');
  await drag(-21, 24, 6);
  await expect.poll(editor).toMatchObject({ pending: false });
  await page.keyboard.press('v');
  await page.evaluate(() => window.__towns!.setSpeed(360));
  await page.waitForFunction(() => {
    if (!window.__towns!.town()!.businesses.some(b => b.zone === 'shops' && b.capacity > 0 && b.occupied === b.capacity)) return false;
    window.__towns!.setSpeed(0);
    return true;
  }, null, { timeout: 90_000 });
  const shop = await page.evaluate(() => window.__towns!.town()!.businesses.find(b => b.zone === 'shops' && b.capacity && b.occupied === b.capacity)!);
  await page.mouse.click(...at(shop.lot.x, shop.lot.y));
  await page.getByLabel('Parking occupancy').check();
  await expect(page.getByRole('region', { name: 'Business' })).toContainText('Parking');
  const card = (await page.getByRole('region', { name: 'Business' }).boundingBox())!;
  const tools = (await page.getByRole('group', { name: 'Map tools' }).boundingBox())!;
  expect(card.y + card.height).toBeLessThan(tools.y);
  await page.screenshot({ path: 'artifacts/screens/parking-full-yard.png' });
  await page.getByRole('button', { name: 'Close business card' }).click();
  await page.getByRole('button', { name: 'Build parking lot' }).click();
  await page.getByLabel('Lot size').selectOption('2');
  await page.mouse.move(...at(6, -1));
  await expect(page.locator('.preview-cost')).toContainText('$160');
  await page.screenshot({ path: 'artifacts/screens/parking-lot-preview.png' });
  await page.mouse.click(...at(6, -1));
  await expect.poll(() => page.evaluate(() => window.__towns!.town()!.bays.filter(b => b.kind === 'lot').length)).toBe(4);
  await page.keyboard.press('v');
  await page.evaluate(() => window.__towns!.setSpeed(360));
  await page.waitForFunction(() => {
    if (!window.__towns!.town()!.bays.some(b => b.kind === 'lot' && b.model)) return false;
    window.__towns!.setSpeed(0);
    return true;
  }, null, { timeout: 90_000 });
  await page.screenshot({ path: 'artifacts/screens/parking-lot-serving.png' });
});

test('drivers park on a street with side bays', async ({ page }) => {
  const { at, drag, editor } = await connectedStreet(page);
  await page.keyboard.press('u');
  await page.keyboard.press('7');
  await page.mouse.click(...at(0, 8));
  await expect.poll(editor).toMatchObject({ pending: false });
  await page.keyboard.press('z');
  await page.keyboard.press('s');
  await drag(-21, 18, 6);
  await expect.poll(editor).toMatchObject({ pending: false });
  await page.keyboard.press('v');
  await page.mouse.move(0, 0);
  await page.evaluate(() => window.__towns!.setSpeed(360));
  await page.waitForFunction(() => {
    if (window.__towns!.town()!.bays.filter(b => b.kind === 'street' && b.model).length < 2) return false;
    window.__towns!.setSpeed(0);
    return true;
  }, null, { timeout: 55_000 });
  await page.screenshot({ path: 'artifacts/screens/parking-street.png' });
});

test('residents walk along the shop frontage', async ({ page }) => {
  test.setTimeout(120_000);
  const { drag, editor } = await connectedStreet(page);
  for (const [brush,start,y,end] of [['h',-34,-8,76],['s',-34,24,16],['w',18,24,76]] as const) {
    await page.keyboard.press(brush);
    await drag(start,y,end);
    await expect.poll(editor).toMatchObject({ pending: false });
  }
  await page.keyboard.press('v');
  await page.mouse.move(0,0);
  await page.evaluate(() => window.__towns!.setSpeed(160));
  await page.waitForFunction(() => {
    const game = window.__towns!;
    const positions = game.walkerPositions();
    const visible: number[] = [];
    for (let i=0; i<positions.length; i+=3) {
      const x = positions[i]!, y = positions[i+1]!;
      if (x < -30 || x > 115 || Math.abs(y-8) > 7 || visible.some(v => Math.abs(v-x)<4)) continue;
      visible.push(x);
    }
    if (visible.length < 4) return false;
    game.setSpeed(0);
    return true;
  }, null, { timeout: 100_000 });
  await page.screenshot({ path: 'artifacts/screens/pavement-walkers.png' });
});

test('a footpath joins the frontage and a zebra carries residents across the street', async ({ page }) => {
  test.setTimeout(180000);
  const { at, drag, editor } = await connectedStreet(page,'',true);
  const stroke = async (x:number,y:number,endX:number,endY:number) => {
    await page.mouse.move(...at(x,y));
    await page.mouse.down();
    await page.mouse.move(...at(endX,endY),{steps:12});
    await page.mouse.up();
  };
  await expect.poll(editor).toMatchObject({connected:true,pending:false});
  await page.getByRole('button',{name:'Build footpath'}).click();
  const balance=()=>page.evaluate(()=>window.__towns!.town()!.budget.balance);
  const before=await balance();
  await stroke(50,3.75,30,-19);
  await expect.poll(balance).toBeLessThan(before);
  await page.screenshot({path:'artifacts/screens/footpath.png'});
  await page.getByRole('button',{name:'Build zebra crossing'}).click();
  const beforeZebra=await balance();
  await page.mouse.click(...at(65,8));
  await expect.poll(balance).toBe(beforeZebra-45);
  await page.keyboard.press('z');
  for(const [brush,start,y,end] of [['h',-34,-8,76],['w',20,24,90]] as const){
    await page.keyboard.press(brush);
    await drag(start,y,end);
    await expect.poll(editor).toMatchObject({pending:false});
  }
  await page.keyboard.press('v');
  await page.evaluate(()=>window.__towns!.setSpeed(200));
  await page.waitForFunction(()=>{
    const g=window.__towns!;
    if(!g.stats()?.zebraWaits) return false;
    g.setSpeed(0);return true;
  },null,{timeout:140000});
  await page.screenshot({path:'artifacts/screens/zebra-crossing.png'});
});

test('pedestrians use the side-street crossing at a junction', async ({page})=>{
  test.setTimeout(150000);
  const {at,drag,editor}=await connectedStreet(page);
  await page.keyboard.press('r');
  await page.mouse.move(...at(20,8));
  await page.mouse.down();
  await page.mouse.move(...at(20,48),{steps:12});
  await page.mouse.up();
  await expect.poll(editor).toMatchObject({roadCount:2,pending:false});
  await page.keyboard.press('z');
  for(const [brush,start,end] of [['h',-32,8],['w',34,78]] as const){
    await page.keyboard.press(brush);
    await drag(start,24,end);
    await expect.poll(editor).toMatchObject({pending:false});
  }
  await page.keyboard.press('v');
  await page.evaluate(()=>window.__towns!.setSpeed(180));
  await page.waitForFunction(()=>{
    const g=window.__towns!, p=g.walkerPositions();
    for(let i=0;i<p.length;i+=3) if(Math.abs(p[i]!-20)<3 && Math.abs(p[i+1]!-18)<1) {
      g.setSpeed(0); return true;
    }
    return false;
  },null,{timeout:120000});
  await page.screenshot({path:'artifacts/screens/junction-walker.png'});
});

test('a neighbourhood park welcomes visitors after work',async({page})=>{
  const {at}=await connectedStreet(page);
  await page.getByRole('button',{name:'Build park',exact:true}).click();
  await page.getByLabel('Park size').selectOption('3');
  await page.mouse.move(...at(8,17));
  await expect(page.locator('.preview-cost')).toContainText('$315');
  await page.mouse.click(...at(8,17));
  await expect.poll(()=>page.evaluate(()=>window.__towns!.town()!.households.some(h=>!!h.nearbyPark))).toBe(true);
  await page.keyboard.press('v');
  await page.mouse.move(0,0);
  await page.evaluate(()=>window.__towns!.setSpeed(120));
  await page.waitForFunction(()=>{
    const game=window.__towns!;
    if ((game.town()?.parkVisitors ?? 0)<3) return false;
    game.setSpeed(0);
    return true;
  },null,{timeout:50000});
  await page.screenshot({path:'artifacts/screens/park-visitors.png'});
});
