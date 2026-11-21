import { expect, it } from 'vitest';
import { meadowScenario, planMeadowRoad } from '../../src/sim/scenarios/meadow';
import { VEHICLE_LENGTH } from '../../src/sim/traffic/idm';
import { World } from '../../src/sim/world';
import { decodeCellKey, type CellKey } from '../../src/sim/zoning/cells';
import type { ZoneKind } from '../../src/sim/zoning/paint';

const day = 28800;
const scenario = meadowScenario();
// A single shop and workshop on the west street, isolated from the east neighbourhood.
const zoning = new Map<CellKey, ZoneKind>();
for (const raw of scenario.zones!.keys) {
  const key = raw as CellKey;
  const { road, column, side } = decodeCellKey(key);
  if (road === 1 && column === 13) zoning.set(key, side === 0 ? 'shops' : 'workplaces');
}

function run() {
  const world = new World(scenario, 1);
  world.setZoning(zoning);
  const initial = world.townView()!;
  let customers = 0, gap = Infinity, eastShopped = false;
  for (let tick = 0; tick < 5 * day; tick++) {
    world.step();
    const v = world.vehicles;
    for (let i = 0; i < v.highWater; i++) {
      if (!v.alive[i]) continue;
      for (let j = 0; j < i; j++) {
        if (v.alive[j] && v.lane[i] === v.lane[j]) gap = Math.min(gap, Math.abs(v.s[i]! - v.s[j]!));
      }
    }
    if (tick % 200 !== 0) continue;
    const view = world.townView()!;
    for (const business of view.businesses) customers = Math.max(customers, business.customers);
    if (view.households.some(h => h.region === 'Eastford' && h.members.some(p => p.errand === 'shop' && p.place === 'Eastford'))) eastShopped = true;
  }
  return { world, initial, customers, gap, eastShopped };
}

it('hires reachable residents, serves local shoppers and retains the isolated off-map shop', () => {
  const { world, initial, customers, gap, eastShopped } = run();
  const view = world.townView()!;
  expect(view.businesses).toHaveLength(2);
  for (const b of view.businesses) {
    expect(b.filled).toBeGreaterThan(0);
    expect(b.filled).toBeLessThanOrEqual(b.jobs);
    const workers = view.households.filter(h => h.region === 'Westbrook').flatMap(h => h.members).filter(p => p.job === b.name);
    expect(workers).toHaveLength(b.filled);
  }
  expect(customers).toBeGreaterThan(0);
  expect(eastShopped).toBe(true);
  expect(view.demand.workplaces).toBeLessThan(initial.demand.workplaces);
  expect(view.demand.residential).toBeGreaterThanOrEqual(initial.demand.residential);
  expect(gap).toBeGreaterThanOrEqual(VEHICLE_LENGTH - 0.01);
  expect(world.stats().lost).toBe(0);
  const replay = run().world;
  expect(replay.hash()).toBe(world.hash());
  expect(replay.townView()).toEqual(view);
});

it('rezoning a business mid-commute cancels the trip and releases its employees', () => {
  const { world } = run();
  const view = world.townView()!;
  const business = view.businesses.find(b => b.zone === 'workplaces')!;
  const workers = view.households.flatMap(h => h.members).filter(p => p.job === business.name);
  for (let t = 0; t < day; t++) {
    world.step();
    const v = world.vehicles;
    const slot = v.alive.findIndex((alive, i) => !!alive && workers.some(p => p.id === v.owner[i])
      && v.dest[i] === world.routing.sinks.length + business.home);
    if (slot < 0) continue;
    const changed = new Map(zoning);
    changed.set(business.lot.key, 'residential');
    world.setZoning(changed);
    expect(v.alive[slot]).toBe(0);
    const after = world.townView()!;
    expect(after.households.flatMap(h => h.members).every(p => p.job !== business.name)).toBe(true);
    expect(after.events.filter(e => e.kind === 'lostJob' && e.region === business.name)).toHaveLength(workers.length);
    expect(after.businesses.map(b => b.zone)).toEqual(['shops']);
    for (let i = 0; i < day; i++) world.step();
    expect(world.stats().lost).toBe(0);
    return;
  }
  throw new Error('Expected a commute to the workshop');
});

it('stops opening shops when residents are served, then resumes after a closure', () => {
  const shops = new Map(Array.from(scenario.zones!.keys, k => [k as CellKey, 'shops'] as const));
  const world = new World(scenario, 1);
  world.setZoning(shops);
  const initial = world.townView()!;
  for (let i = 0; i < 12 * day; i++) world.step();
  const served = world.townView()!;
  expect(served.demand.shops).toBe(0);
  expect(served.businesses).toHaveLength(Math.ceil(initial.totals.population / 8));
  for (let i = 0; i < day; i++) world.step();
  expect(world.townView()!.businesses).toHaveLength(served.businesses.length);
  shops.delete(served.businesses[0]!.lot.key);
  world.setZoning(shops);
  expect(world.townView()!.demand.shops).toBeGreaterThan(0);
  for (let i = 0; i < 12 * day; i++) world.step();
  expect(world.townView()!.demand.shops).toBe(0);
});

it('closes a shop when a new road covers it and grows a replacement after undo', () => {
  const { world } = run();
  const before = world.townView()!;
  const plan = planMeadowRoad([], { x: -65, y: 62 }, { x: -65, y: -8 });
  if (!plan.ok) throw new Error(plan.reason);
  const edit = world.editNetwork(meadowScenario([plan.road]));
  if (!edit.ok) throw new Error(edit.reason);
  const after = edit.world.townView()!;
  expect(after.businesses.map(b => b.zone)).toEqual(['workplaces']);
  const shop = before.businesses.find(b => b.zone === 'shops')!;
  expect(after.households.flatMap(h => h.members).some(p => p.job === shop.name)).toBe(false);
  const undo = edit.world.editNetwork(scenario);
  if (!undo.ok) throw new Error(undo.reason);
  for (let t = 0; t < day; t++) undo.world.step();
  expect(undo.world.townView()!.businesses.map(b => b.zone)).toContain('shops');
  expect(undo.world.stats().lost).toBe(0);
});

it('responds to each brush before construction starts', () => {
  for (const zone of ['residential', 'shops', 'workplaces'] as const) {
    const world = new World(scenario, 1);
    const before = world.townView()!.demand;
    world.setZoning(new Map(Array.from(scenario.zones!.keys, k => [k as CellKey, zone])));
    const after = world.townView()!.demand;
    expect(after[zone]).toBeLessThan(before[zone]);
    if (zone === 'residential') expect(after.workplaces).toBeGreaterThan(before.workplaces);
    else expect(after.residential).toBeGreaterThan(before.residential);
  }
});

it('keeps all three demand bars inside their range in the mixed preset', () => {
  const world = new World(scenario, 1);
  world.setZoning(new Map(Array.from(scenario.zones!.keys, raw => {
    const key = raw as CellKey;
    const {column, side} = decodeCellKey(key);
    const band = (column + side * 2) % 6;
    return [key, band < 3 ? 'residential' : band === 3 ? 'shops' : 'workplaces'];
  })));
  for (let d = 0; d < 10; d++) {
    for (let t = 0; t < day; t++) world.step();
    for (const value of Object.values(world.townView()!.demand)) {
      expect(value).toBeGreaterThan(0);
      expect(value).toBeLessThan(100);
    }
  }
});
