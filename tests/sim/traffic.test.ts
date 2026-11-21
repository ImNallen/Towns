import { describe, expect, it } from 'vitest';
import { buildScenario, type ScenarioName } from '../../src/sim/scenarios';
import { DT, World } from '../../src/sim/world';

const MINUTE = 60 / DT;

function run(name: ScenarioName, seed: number, ticks: number, each?: (w: World) => void): World {
  const world = new World(buildScenario(name), seed);
  for (let t = 0; t < ticks; t++) {
    world.step();
    each?.(world);
  }
  return world;
}

/** Pairs of vehicles on the same lane closer than their physical length. */
function overlaps(world: World): number {
  const V = world.vehicles;
  const byLane = new Map<number, number[]>();
  for (let i = 0; i < V.highWater; i++) {
    if (!V.alive[i]) continue;
    const list = byLane.get(V.lane[i]!) ?? [];
    list.push(i);
    byLane.set(V.lane[i]!, list);
  }
  let count = 0;
  for (const list of byLane.values()) {
    list.sort((a, b) => V.s[a]! - V.s[b]!);
    for (let k = 1; k < list.length; k++) if (V.s[list[k]!]! - V.s[list[k - 1]!]! < V.length[list[k]!]! - 0.25) count++;
  }
  return count;
}

describe('determinism', () => {
  it('same seed gives identical state', () => {
    expect(run('roundabout', 7, 3000).hash()).toBe(run('roundabout', 7, 3000).hash());
  });

  it('different seeds diverge', () => {
    expect(run('roundabout', 7, 3000).hash()).not.toBe(run('roundabout', 8, 3000).hash());
  });
});

describe('routing', () => {
  it('every roundabout entry can reach every other road', () => {
    const world = new World(buildScenario('roundabout'), 1);
    const { routing, scenario } = world;
    for (const d of scenario.demand) {
      routing.sinks.forEach((_, dest) => expect(routing.canReach(dest, d.lane)).toBe(true));
    }
  });
});

describe('car following', () => {
  it('never overlaps on a straight road', () => {
    let worst = 0;
    const world = run('straight', 3, 10 * MINUTE, (w) => {
      if (w.tick % 10 === 0) worst = Math.max(worst, overlaps(w));
    });
    expect(worst).toBe(0);
    expect(world.stats().completed).toBeGreaterThan(100);
  });
});

describe('roundabout', () => {
  it('keeps flowing without overlaps or lost vehicles', () => {
    let worstOverlap = 0;
    let stalledMinutes = 0;
    let completedAtMinute = 0;
    const world = run('roundabout', 1, 20 * MINUTE, (w) => {
      if (w.tick % 10 === 0) worstOverlap = Math.max(worstOverlap, overlaps(w));
      // After a 3-minute warm-up (trips take ~80s), every minute must complete some trips.
      if (w.tick % MINUTE === 0) {
        const done = w.stats().completed;
        if (w.tick > 3 * MINUTE && w.vehicles.count > 0 && done === completedAtMinute) stalledMinutes++;
        completedAtMinute = done;
      }
    });
    const stats = world.stats();
    expect(stats.lost).toBe(0);
    expect(worstOverlap).toBe(0);
    expect(stalledMinutes).toBe(0);
    expect(stats.completed).toBeGreaterThan(300);
    expect(stats.meanSpeed).toBeGreaterThan(3);
  });

  it('saturates gracefully at 3x demand: queues, but no overlaps or gridlock', () => {
    const scenario = buildScenario('roundabout');
    for (const d of scenario.demand) d.rate *= 3;
    const world = new World(scenario, 2);
    let worstOverlap = 0;
    for (let t = 0; t < 15 * MINUTE; t++) {
      world.step();
      if (t % 5 === 0) worstOverlap = Math.max(worstOverlap, overlaps(world));
    }
    const stats = world.stats();
    expect(worstOverlap).toBe(0);
    expect(stats.lost).toBe(0);
    // A single-lane roundabout tops out around 30-40 vehicles/minute.
    expect(stats.completedLastMinute).toBeGreaterThan(25);
  });
});
