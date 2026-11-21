import { expect, it } from 'vitest';
import { meadowScenario, meadowTips, planMeadowRoad, type MeadowEdit } from '../../src/sim/scenarios/meadow';
import { BUDGET, ECONOMY } from '../../src/sim/town/economy';
import { Treasury, editCost, undoCost } from '../../src/sim/town/budget';
import { CLOCK_START } from '../../src/sim/town/town';
import { World } from '../../src/sim/world';
import { decodeCellKey, type CellKey } from '../../src/sim/zoning/cells';
import { planZoneStroke, type ZoneKind } from '../../src/sim/zoning/paint';

const firstMidnight = (1440 - CLOCK_START) * 20 + 1;
const day = 1440 * 20;

it('prices road geometry, salvages only the selected arm, and reverses both postings exactly', () => {
  const treasury = new Treasury();
  const [west, east] = meadowTips([]);
  const curve = planMeadowRoad([], west!, east!, { x: 0, y: 50 });
  if (!curve.ok) throw new Error(curve.reason);
  const cost = editCost([], curve.road);
  expect(cost).toBe(Math.round(curve.path.length * BUDGET.roadPerMetre));
  expect(cost).toBeGreaterThan(Math.hypot(west!.x - east!.x, west!.y - east!.y) * BUDGET.roadPerMetre);
  const crossing = planMeadowRoad([], {x: -65, y: -48}, {x: -65, y: 48});
  if (!crossing.ok) throw new Error(crossing.reason);
  const previous = [crossing.road];
  const build = editCost([], crossing.road);
  expect(build).toBe(96 * BUDGET.roadPerMetre);
  const scenario = meadowScenario(previous);
  const remove = { remove: 0 };
  const removed = meadowScenario([...previous, remove]);
  const metres = scenario.town!.roadMetres - removed.town!.roadMetres;
  const salvage = editCost(previous, remove);
  expect(salvage).toBe(-Math.round(metres * BUDGET.roadPerMetre * BUDGET.salvageShare));
  for (const amount of [build, salvage, undoCost([...previous, remove]), undoCost(previous)]) expect(treasury.book(amount)).toBeUndefined();
  expect(treasury.balance).toBe(BUDGET.startingBalance);
  expect(treasury.today.building).toBe(0);
});

it('bills changed cells only and erases for free, even when overdrawn', () => {
  const cells = meadowScenario().zones!;
  const key = cells.keys[0]! as CellKey;
  const plan = planZoneStroke(cells, new Map(), 'shops', [key, key]);
  if (!plan.ok) throw new Error(plan.reason);
  const cost = editCost([], plan.stroke);
  const treasury = new Treasury();
  expect(cost).toBe(BUDGET.zonePerCell * plan.stroke.cells.length);
  treasury.book(cost);
  treasury.book(undoCost([plan.stroke]));
  expect(treasury.balance).toBe(BUDGET.startingBalance);
  treasury.book(treasury.balance);
  treasury.close(100);
  const overdrawn = treasury.view();
  expect(treasury.book(cost)).toContain('you have −$');
  expect(treasury.view()).toEqual(overdrawn);
  expect(treasury.book(editCost([], { ...plan.stroke, zone: null }))).toBeUndefined();
  expect(treasury.balance).toBe(overdrawn.balance);
});

it('closes actual earnings and payroll at midnight and carries seven balances across edits', () => {
  const world = new World(meadowScenario(), 1);
  const zoning = new Map<CellKey, ZoneKind>();
  for (const raw of world.scenario.zones!.keys) {
    const key = raw as CellKey;
    const { column, side } = decodeCellKey(key);
    const band = (column + side * 2) % 6;
    zoning.set(key, band < 3 ? 'residential' : band === 3 ? 'shops' : 'workplaces');
  }
  const seedCost = zoning.size * BUDGET.zonePerCell;
  expect(world.treasury!.book(seedCost)).toBeUndefined();
  world.setZoning(zoning);
  const previousWages = new Map<number, number>();
  let previousBusinessTaxes = 0;
  const closes: number[] = [];
  for (let tick = 1; tick <= firstMidnight + 8 * day; tick++) {
    if ((tick - firstMidnight) % day !== 0) {
      world.step();
      continue;
    }
    const before = world.townView()!;
    world.step();
    const view = world.townView()!;
    const { homes, shops, workplaces, upkeep } = view.budget.yesterday;
    // Growth runs on the hour, so shops that first open at midnight owe their first rate then.
    const newShopRates = view.businesses.filter(b => b.zone === 'shops' && !before.businesses.some(old => old.home === b.home))
      .reduce((sum, b) => sum + b.lot.columns * b.lot.rows * BUDGET.shopRatePerCell, 0);
    expect({ ...before.budget.today, shops: before.budget.today.shops + newShopRates }).toEqual(view.budget.yesterday);
    expect(before.budget.today.homes).toBeGreaterThan(0);
    expect(before.budget.today.shops).toBeGreaterThan(0);
    let expected = 0;
    for (const h of view.households) {
      const tax = Math.round((h.wages - (previousWages.get(h.id) ?? 0)) * BUDGET.homeTax);
      expected += tax;
      const prior = before.households.find(home => home.id === h.id);
      if (prior && prior.level === h.level && prior.cars === h.cars && prior.carModel === h.carModel) {
        const adults = h.members.filter(p => p.role === 'adult').length;
        const livingCost = adults * ECONOMY.adultCost + (h.members.length - adults) * ECONOMY.childCost
          + h.cars * ECONOMY.carUpkeep + ECONOMY.houseUpkeep[h.level]!;
        expect(prior.funds - h.funds).toBeCloseTo(livingCost + tax);
      }
      previousWages.set(h.id, h.wages);
    }
    expect(homes).toBe(expected);
    const totalTaxes = view.businesses.reduce((n, b) => n + b.taxesPaid, 0);
    expect(shops + workplaces).toBe(totalTaxes - previousBusinessTaxes);
    previousBusinessTaxes = totalTaxes;
    for (const b of view.businesses.filter(b => b.zone === 'workplaces')) {
      const tax = b.taxesPaid - (before.businesses.find(prior => prior.home === b.home)?.taxesPaid ?? 0);
      expect(tax).toBe(Math.round((b.lastDailyCost - tax) * BUDGET.workplaceTax));
    }
    expect(upkeep).toBe(Math.round(world.scenario.town!.roadMetres * BUDGET.upkeepPerMetre));
    expect(view.budget.balance).toBe((closes.at(-1) ?? BUDGET.startingBalance - seedCost) + homes + shops + workplaces - upkeep);
    closes.push(view.budget.balance);
    expect(view.budget.history).toEqual(closes.slice(-7));
  }
  expect(Math.min(...closes)).toBeGreaterThan(0);
  expect(world.townView()!.households.length).toBeGreaterThan(world.scenario.town!.homes.length);
  const rebuilt = world.editNetwork(meadowScenario());
  if (!rebuilt.ok) throw new Error(rebuilt.reason);
  expect(rebuilt.world.townView()!.budget).toEqual(world.townView()!.budget);
  expect(world.stats().lost).toBe(0);
});

it('runs short maintaining unzoned roads while the clock and traffic keep moving', () => {
  const edits: MeadowEdit[] = [];
  const costs: number[] = [];
  for (const y of [-84, -48, 46, 82]) {
    const road = planMeadowRoad(edits, { x: -60, y }, { x: 60, y });
    if (!road.ok) throw new Error(road.reason);
    costs.push(editCost(edits, road.road));
    edits.push(road.road);
  }
  const run = () => {
    const world = new World(meadowScenario(edits), 1);
    for (const cost of costs) expect(world.treasury!.book(cost)).toBeUndefined();
    for (let t = 0; t < 10 * day; t++) world.step();
    return world;
  };
  const world = run();
  expect(world.treasury!.balance).toBeLessThan(0);
  expect(world.treasury!.book(BUDGET.zonePerCell)).toContain('you have');
  expect(world.townView()!.day).toBe(11);
  expect(world.stats().completed).toBeGreaterThan(0);
  expect(world.stats().lost).toBe(0);
  expect(world.hash()).toBe(run().hash());
});

it('retains tax on wages already earned when housing is erased before midnight', () => {
  const world = new World(meadowScenario(), 1);
  const paint = new Map(Array.from(world.scenario.zones!.keys, raw => [raw as CellKey, 'residential'] as const));
  world.setZoning(paint);
  for (let i = 0; i < 4 * day; i++) world.step();
  // By 22:00 the day’s returning commuters have booked their pay.
  for (let i = 0; i < (22 * 60 - CLOCK_START) * 20; i++) world.step();
  const before = world.townView()!;
  expect(before.households.some(h => h.lot && h.wages > 0)).toBe(true);
  world.setZoning(new Map());
  expect(world.townView()!.budget.today.homes).toBe(before.budget.today.homes);
  for (let i = 0; i <= 2 * 60 * 20; i++) world.step();
  expect(world.townView()!.budget.yesterday.homes).toBe(before.budget.today.homes);
});
