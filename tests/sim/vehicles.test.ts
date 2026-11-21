import { expect, it } from 'vitest';
import { NetworkBuilder } from '../../src/sim/network/builder';
import { polyline } from '../../src/sim/math/polyline';
import { straightRoad } from '../../src/sim/scenarios/straight';
import { Model, VEHICLES } from '../../src/vehicles/catalogue';
import { DT, World } from '../../src/sim/world';
import { meadowScenario } from '../../src/sim/scenarios/meadow';
import { ECONOMY } from '../../src/sim/town/economy';

it.each(VEHICLES)('$name accelerates from rest and approaches its own speed limit', type => {
  const scenario = straightRoad();
  scenario.demand = [];
  const builder = new NetworkBuilder();
  const { forward } = builder.addTwoWayRoad(polyline([{ x: 0, y: 0 }, { x: 6500, y: 0 }]),
    { width: 8, laneWidth: 3.5, speedLimit: 50 });
  scenario.network = builder.build();
  const world = new World(scenario, 1);
  const slot = world.vehicles.spawn(forward, 0, 0, world.routing.sinks.indexOf(forward), 0, -1, type.model);
  world.step();
  expect(world.vehicles.v[slot]).toBeCloseTo(type.accel * DT);
  for (let tick = 0; tick < 3500; tick++) world.step();
  expect(world.vehicles.v[slot]).toBeCloseTo(type.speed, 2);
  expect(world.stats().lost).toBe(0);
});

it('seeds affordable family estates and trades up as savings accumulate', () => {
  const world = new World(meadowScenario(), 1);
  const initial = world.townView()!.households;
  for (const h of initial) {
    const family = h.members.some(p => p.role !== 'adult');
    expect(h.carModel).toBe(family && h.funds >= ECONOMY.carPrice[Model.Estate] ? Model.Estate : Model.Hatchback);
  }
  for (let tick = 0; tick < 28800 * 30; tick++) world.step();
  const town = world.townView()!;
  expect(town.totals.carsBought).toBeGreaterThan(0);
  expect(town.households.some(h => h.carModel === Model.SUV)).toBe(true);
  expect(world.stats().lost).toBe(0);
});

it('admits mixed through traffic with space behind each rear bumper', () => {
  const scenario = straightRoad();
  scenario.demand = scenario.demand.map(({lane, rate}) => ({lane, rate}));
  const world = new World(scenario, 7);
  const models = new Set<number>();
  let minGap = Infinity;
  for (let tick = 0; tick < 24000; tick++) {
    world.step();
    const v = world.vehicles;
    for (let i = 0; i < v.highWater; i++) {
      if (!v.alive[i]) continue;
      models.add(v.model[i]!);
      for (let j = 0; j < i; j++) {
        if (!v.alive[j] || v.lane[i] !== v.lane[j]) continue;
        const leader = v.s[i]! > v.s[j]! ? i : j;
        minGap = Math.min(minGap, Math.abs(v.s[i]! - v.s[j]!) - v.length[leader]!);
      }
    }
  }
  expect(models.size).toBe(VEHICLES.length);
  expect(minGap).toBeGreaterThanOrEqual(0);
  expect(world.stats().lost).toBe(0);
});
