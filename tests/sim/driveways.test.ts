import { describe, expect, it } from 'vitest';
import { meadowScenario, meadowTips, planMeadowRoad } from '../../src/sim/scenarios/meadow';
import { DT, World } from '../../src/sim/world';

const DAY = 1440 / DT;

describe('driveways', () => {
  it('resident cars slow down to turn into their driveway', () => {
    const [west, east] = meadowTips([]);
    const road = planMeadowRoad([], west!, east!);
    if (!road.ok) throw new Error(road.reason);
    const world = new World(meadowScenario([road.road]), 1);
    const V = world.vehicles;
    const sinks = world.routing.sinks.length;
    // Last speed seen for each car still heading to a building.
    const speeds = new Map<number, number>();
    const arrivals: number[] = [];
    for (let t = 0; t < 2 * DAY; t++) {
      world.step();
      const alive = new Set<number>();
      for (let slot = 0; slot < V.highWater; slot++) {
        if (!V.alive[slot] || V.dest[slot]! < sinks) continue;
        alive.add(V.id[slot]!);
        speeds.set(V.id[slot]!, V.v[slot]!);
      }
      for (const [id, v] of speeds) {
        if (alive.has(id)) continue;
        arrivals.push(v);
        speeds.delete(id);
      }
    }
    expect(arrivals.length).toBeGreaterThan(20);
    expect(Math.max(...arrivals)).toBeLessThan(6);
    expect(world.stats().lost).toBe(0);
  });
});
