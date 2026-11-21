import { describe, expect, it } from 'vitest';
import { straightRoad } from '../../src/sim/scenarios/straight';
import type { Scenario } from '../../src/sim/scenarios/types';
import { World } from '../../src/sim/world';

/** The straight road with one building halfway along, reached from either lane at x = 0. */
function withBuilding(): { scenario: Scenario; forward: number; backward: number } {
  const base = straightRoad();
  const [forward, backward] = base.demand.map((d) => d.lane) as [number, number];
  const scenario: Scenario = {
    ...base,
    demand: [],
    town: { roadMetres: 0, homes: [{ access: [{ lane: forward, s: 400 }, { lane: backward, s: 400 }], region: 0 }], regions: [] },
  };
  return { scenario, forward, backward };
}

describe('building destinations', () => {
  it('ends a trip at the driveway instead of the lane end', () => {
    const { scenario, forward } = withBuilding();
    const world = new World(scenario, 1);
    const building = world.routing.sinks.length;
    const car = world.vehicles.spawn(forward, 0, 10, building, 0);
    let furthest = 0;
    for (let i = 0; i < 2000 && world.vehicles.alive[car]; i++) {
      furthest = world.vehicles.s[car]!;
      world.step();
    }
    expect(world.stats()).toMatchObject({ completed: 1, lost: 0, active: 0 });
    expect(furthest).toBeGreaterThan(398);
    expect(furthest).toBeLessThan(400);
  });

  it('leaves a driveway at rest on the lane that reaches the destination', () => {
    const { scenario, forward, backward } = withBuilding();
    const world = new World(scenario, 1);
    const access = scenario.town!.homes[0]!.access;
    const east = world.routing.sinks.indexOf(forward);
    const west = world.routing.sinks.indexOf(backward);
    expect(access[world.routing.bestAccess(access, east)]!.lane).toBe(forward);
    expect(access[world.routing.bestAccess(access, west)]!.lane).toBe(backward);

    expect(world.trySpawnAt(forward, 400, east, 7)).toBe(true);
    const slot = world.vehicles.highWater - 1;
    expect(world.vehicles.v[slot]).toBe(0);
    expect(world.vehicles.owner[slot]).toBe(7);
    expect(world.trySpawnAt(backward, 400, east, 8)).toBe(false);
    for (let i = 0; i < 1500; i++) world.step();
    expect(world.stats()).toMatchObject({ spawned: 1, completed: 1, lost: 0 });
  });

  it('refuses to pull out next to a car ahead, before a car that cannot stop, or while admissions are closed', () => {
    const { scenario, forward } = withBuilding();
    const world = new World(scenario, 1);
    const east = world.routing.sinks.indexOf(forward);
    const ahead = world.vehicles.spawn(forward, 405, 0, east, 0);
    expect(world.trySpawnAt(forward, 400, east, 1)).toBe(false);
    world.vehicles.despawn(ahead);

    const fast = world.vehicles.spawn(forward, 380, 15, east, 0);
    expect(world.trySpawnAt(forward, 400, east, 1)).toBe(false);
    world.vehicles.s[fast] = 300;
    world.vehicles.v[fast] = 10;
    world.setAdmissions(false);
    expect(world.trySpawnAt(forward, 400, east, 1)).toBe(false);
    world.setAdmissions(true);
    expect(world.trySpawnAt(forward, 400, east, 1)).toBe(true);
    for (let i = 0; i < 1500; i++) world.step();
    expect(world.stats()).toMatchObject({ completed: 2, lost: 0 });
  });
});
