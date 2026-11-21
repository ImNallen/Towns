import { expect, it } from 'vitest';
import { NetworkBuilder } from '../../src/sim/network/builder';
import { ROAD_ORDER, ROAD_TYPES, edgeOffset } from '../../src/sim/network/roadTypes';
import { buildStreetNetwork } from '../../src/sim/network/streets';
import { meadowScenario, meadowTips, upgradeFailure, planMeadowRoad } from '../../src/sim/scenarios/meadow';
import { editCost, undoCost } from '../../src/sim/town/budget';
import { BUDGET } from '../../src/sim/town/economy';
import { VEHICLE_LENGTH } from '../../src/sim/traffic/idm';
import { Routing } from '../../src/sim/traffic/routing';
import { World } from '../../src/sim/world';
import { decodeCellKey, type CellKey } from '../../src/sim/zoning/cells';

it.each(ROAD_ORDER)('%s governs free-flow time, driving speed and roadside surfaces', type => {
  const ends = [{ x: 0, y: 0 }, { x: 1500, y: 0 }];
  const { network } = buildStreetNetwork(new NetworkBuilder(), [ends], ends, [], [type]);
  const limit = ROAD_TYPES[type].speedLimit;
  expect(new Routing(network).travelTime(1, 0)).toBeCloseTo(1500 / limit);
  const world = new World({ ...meadowScenario(), town: undefined, network, demand: [] }, 1);
  const slot = world.vehicles.spawn(0, 0, 1, 1, 0);
  for (let i = 0; i < 1000; i++) world.step();
  expect(world.vehicles.v[slot]).toBeCloseTo(limit, 1);
  expect(network.surfaces.filter(s => s.style === 'parking')).toHaveLength(type === 'parking' ? 2 : 0);
  expect(network.surfaces.filter(s => s.style === 'pavement')).toHaveLength(type === 'country' ? 0 : 2);
});

it('prices a segment upgrade, downgrade, undo and daily upkeep at its current type', () => {
  const upgrade = { upgrade: 0, roadType: 'parking' } as const;
  const downgrade = { upgrade: 0, roadType: 'town' } as const;
  const metres = 129;
  const difference = metres * (ROAD_TYPES.parking.cost - ROAD_TYPES.town.cost);
  expect(editCost([], upgrade)).toBe(difference);
  expect(undoCost([upgrade])).toBe(-difference);
  expect(editCost([upgrade], downgrade)).toBe(-Math.round(difference * BUDGET.salvageShare));
  const scenario = meadowScenario([upgrade]);
  expect(scenario.town!.roadUpkeep).toBe(Math.round((280 - metres) * ROAD_TYPES.town.upkeep + metres * ROAD_TYPES.parking.upkeep));
  const cells = scenario.zones!;
  const i = cells.keys.findIndex(k => { const c = decodeCellKey(k as CellKey); return c.road === 1 && c.side === 0 && c.row === 0; });
  expect(cells.corners[i * 8 + 1]).toBeCloseTo(-8 + edgeOffset('parking', 'left') + 0.5);
});

it('joins mixed types at a crossing with yielding movements', () => {
  const plan = planMeadowRoad([], { x: -65, y: -48 }, { x: -65, y: 48 }, undefined, 'country');
  if (!plan.ok) throw new Error(plan.reason);
  const network = meadowScenario([plan.road]).network;
  expect(network.lanes.filter(l => l.kind === 'connector')).toHaveLength(12);
  expect(network.lanes.some(l => l.crossingYieldTo.length)).toBe(true);
  expect(new Set(network.lanes.filter(l => l.kind === 'road').map(l => l.speedLimit))).toEqual(new Set([11.1, 16.7]));
});

it('upgrades and undoes under traffic deterministically with no lost or overlapping cars', () => {
  const [a, b] = meadowTips([]);
  const road = planMeadowRoad([], a!, b!);
  if (!road.ok) throw new Error(road.reason);
  const original = meadowScenario([road.road]);
  const upgraded = meadowScenario([road.road, { upgrade: 2, roadType: 'parking' }]);
  function run() {
    let world = new World(original, 12);
    for (let tick = 0; tick < 2400; tick++) {
      if (tick === 800 || tick === 1600) {
        expect(world.stats().active).toBeGreaterThan(0);
        const change = world.editNetwork(tick === 800 ? upgraded : original);
        if (!change.ok) throw new Error(change.reason);
        expect(change.world.vehicles.id).toEqual(world.vehicles.id);
        world = change.world;
      }
      world.step();
      const v = world.vehicles;
      for (let i = 0; i < v.highWater; i++) for (let j = 0; j < i; j++) {
        if (v.alive[i] && v.alive[j] && v.lane[i] === v.lane[j])
          expect(Math.abs(v.s[i]! - v.s[j]!)).toBeGreaterThanOrEqual(VEHICLE_LENGTH - 0.25);
      }
    }
    expect(world.stats().lost).toBe(0);
    expect(world.stats().completed).toBeGreaterThan(0);
    return world.hash();
  }
  expect(run()).toBe(run());
});

it('refuses widening into a neighbouring road and permits it after removal', () => {
  const row = (y: number) => ({ roadType: 'country' as const, points: [{ x: -20, y }, { x: 20, y }] });
  const edits = [row(50), row(60)];
  expect(upgradeFailure(edits, 2, 'parking')).toContain('space');
  expect(upgradeFailure([...edits, { remove: 3 }], 2, 'parking')).toBeUndefined();
});

it('moves an occupied parcel to its new kerb and keeps the household', () => {
  const scenario = meadowScenario();
  const world = new World(scenario, 7);
  const frontage = new Map<CellKey, 'residential'>();
  for (const raw of scenario.zones!.keys) {
    const key = raw as CellKey;
    const { road, column } = decodeCellKey(key);
    if (road === 1 && column >= 13) frontage.set(key, 'residential');
  }
  world.setZoning(frontage);
  for (let i = 0; i < 28800; i++) world.step();
  const resident = world.townView()!.households.find(h => h.lot);
  expect(resident?.lot).toBeDefined();
  const result = world.editNetwork(meadowScenario([{ upgrade: 0, roadType: 'parking' }]));
  if (!result.ok) throw new Error(result.reason);
  const moved = result.world.townView()!.households.find(h => h.id === resident!.id);
  expect(moved?.members).toEqual(resident!.members);
  expect(moved?.lot?.key).toBe(resident!.lot!.key);
  expect(Math.abs(moved!.lot!.y - resident!.lot!.y)).toBeCloseTo(2.2);
});
