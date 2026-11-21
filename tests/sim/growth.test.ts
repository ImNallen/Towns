import { expect, it } from 'vitest';
import { BLUEPRINTS } from '../../src/buildings/catalogue';
import { accessPoints, meadowScenario, planMeadowRoad } from '../../src/sim/scenarios/meadow';
import { VEHICLE_LENGTH } from '../../src/sim/traffic/idm';
import { DT, World } from '../../src/sim/world';
import { decodeCellKey, type CellKey } from '../../src/sim/zoning/cells';
import { residentialLots } from '../../src/sim/zoning/lots';

const scenario = meadowScenario();
const paint = new Map(Array.from(scenario.zones!.keys, k => [k as CellKey, 'residential'] as const));
const parcels = residentialLots(scenario, paint);
const day = 28800;
function paintedWorld() {
  const world = new World(scenario, 1);
  world.setZoning(paint);
  return world;
}
function step(world: World, ticks: number) {
  for (let i = 0; i < ticks; i++) world.step();
}

it('packs live street-front cells once, in key order, within blueprint dimensions', () => {
  expect(parcels).toEqual(residentialLots(scenario, new Map([...paint].reverse())));
  const used = new Set<number>();
  for (const lot of parcels) {
    expect(decodeCellKey(lot.key).row).toBe(0);
    expect(BLUEPRINTS.some(b => b.lot.columns === lot.columns && b.lot.rows === lot.rows)).toBe(true);
    for (let c = 0; c < lot.columns; c++) for (let r = 0; r < lot.rows; r++) {
      const k = (lot.key + c * 8 + r) as CellKey;
      expect(paint.has(k) && !used.has(k)).toBe(true);
      used.add(k);
    }
  }
  expect(parcels.some(l => l.rows === 4 && l.columns === 3)).toBe(true);
  const smaller = new Map(paint);
  smaller.delete(parcels[0]!.key);
  const after = residentialLots(scenario, smaller);
  expect(after.filter(l => l.streetX > 0)).toEqual(parcels.filter(l => l.streetX > 0));
});

it('grows four homes per day, commutes and upgrades deterministically', () => {
  const world = paintedWorld();
  step(world, day);
  expect(world.townView()!.households).toHaveLength(16);
  let minGap = Infinity;
  let sawDeparture = false;
  for (let t = day; t < 10 * day; t++) {
    world.step();
    const v = world.vehicles;
    for (let i = 0; i < v.highWater; i++) {
      if (!v.alive[i]) continue;
      if (!sawDeparture && v.departTime[i] === (world.tick - 1) * DT && v.dest[i]! < world.routing.sinks.length) {
        const h = world.townView()!.households.find(h => h.lot && h.members.some(m => m.id === v.owner[i]));
        if (h?.lot) {
          const driveway = accessPoints(scenario.network, { x: h.lot.streetX, y: h.lot.streetY });
          expect(driveway.some(a => a.lane === v.lane[i] && Math.abs(a.s - v.s[i]!) < 0.01)).toBe(true);
          sawDeparture = true;
        }
      }
      for (let j = 0; j < i; j++) {
        if (v.alive[j] && v.lane[i] === v.lane[j]) minGap = Math.min(minGap, Math.abs(v.s[i]! - v.s[j]!));
      }
    }
  }
  expect(sawDeparture).toBe(true);
  expect(minGap).toBeGreaterThanOrEqual(VEHICLE_LENGTH - 0.01);
  const grown = world.townView()!.households.filter(h => h.lot);
  expect(grown.some(h => h.wages > 0)).toBe(true);
  const upgraded = grown.find(h => h.level === 2)!;
  const starter = parcels.find(l => l.key === upgraded.lot!.key)!.designs[0]!;
  expect(starter.blueprint.tier).toBe('cheap');
  expect(upgraded.lot!.design).toBe(starter.blueprint.upgradesTo);
  expect(world.stats().lost).toBe(0);
  const replay = paintedWorld();
  step(replay, 10 * day);
  expect(world.hash()).toBe(replay.hash());
  expect(world.townView()).toEqual(replay.townView());
});

it('clears a demolished family and its moving car while preserving its neighbours', () => {
  const world = paintedWorld();
  step(world, 4 * day);
  const newResidents = new Set(world.townView()!.households.filter(h => h.lot).flatMap(h => h.members.map(m => m.id)));
  const v = world.vehicles;
  for (let i = 0; i < day; i++) {
    world.step();
    const slot = v.alive.findIndex((alive, s) => !!alive && newResidents.has(v.owner[s]!));
    if (slot < 0) continue;
    const homes = world.townView()!.households;
    const family = homes.find(h => h.members.some(m => m.id === v.owner[slot]))!;
    const less = new Map(paint);
    less.delete(family.lot!.key);
    world.setZoning(less);
    expect(v.alive[slot]).toBe(0);
    expect(world.townView()!.households).toEqual(homes.filter(h => h !== family));
    return;
  }
  throw new Error('No grown resident drove');
});

it('a road over a parcel removes the home and undo leaves room to grow again', () => {
  const world = paintedWorld();
  step(world, 4 * day);
  const plan = planMeadowRoad([], {x: -65,y: 62}, {x: -65,y: -8});
  if (!plan.ok) throw new Error(plan.reason);
  const result = world.editNetwork(meadowScenario([plan.road]));
  if (!result.ok) throw new Error(result.reason);
  const homes = result.world.townView()!.households;
  expect(homes.length).toBeLessThan(world.townView()!.households.length);
  expect(homes.filter(h => h.region === 'Eastford')).toEqual(world.townView()!.households.filter(h => h.region === 'Eastford'));
  const undo = result.world.editNetwork(scenario);
  if (!undo.ok) throw new Error(undo.reason);
  expect(undo.world.townView()!.households).toEqual(homes);
  step(undo.world, 2 * day);
  expect(undo.world.townView()!.households).toHaveLength(world.townView()!.households.length);
});
