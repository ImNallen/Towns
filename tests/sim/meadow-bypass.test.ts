import { expect, it } from 'vitest';
import { sampleAt } from '../../src/sim/math/polyline';
import { meadowScenario, meadowSnap, planMeadowRoad } from '../../src/sim/scenarios/meadow';
import { DT, World } from '../../src/sim/world';

it('keeps live trips and sends new traffic both ways along a player-built shortcut', () => {
  const arch = planMeadowRoad([], { x: -65, y: -8 }, { x: 65, y: 8 }, { x: 0, y: 85 });
  if (!arch.ok) throw new Error(arch.reason);
  const roads = [arch.road];
  const start = meadowSnap(roads, { x: -47.27, y: 27.85 }, 4)!;
  const end = meadowSnap(roads, { x: 52.30, y: 27.74 }, 4)!;
  const bypass = planMeadowRoad(roads, start, end);
  if (!bypass.ok) throw new Error(bypass.reason);

  const original = new World(meadowScenario(roads), 7);
  for (let i = 0; i < 8 / DT; i++) original.step();
  expect(original.stats().active).toBeGreaterThan(0);
  const edited = original.editNetwork(meadowScenario([...roads, bypass.road]));
  if (!edited.ok) throw new Error(edited.reason);
  const world = edited.world;
  expect(world.stats()).toEqual(original.stats());
  const firstNewId = Math.max(...original.vehicles.id.subarray(0, original.vehicles.highWater)) + 1;
  const directions = new Set<number>();
  const position = { x: 0, y: 0, hx: 0, hy: 0 };
  for (let i = 0; i < 120 / DT; i++) {
    world.step();
    const cars = world.vehicles;
    for (let slot = 0; slot < cars.highWater; slot++) {
      if (!cars.alive[slot] || cars.id[slot]! < firstNewId) continue;
      sampleAt(world.network.lanes[cars.lane[slot]!]!.path, cars.s[slot]!, position);
      if (Math.abs(position.x) < 1 && Math.abs(position.y - 28) < 4) directions.add(Math.sign(position.hx));
    }
  }
  expect(directions).toEqual(new Set([-1, 1]));
  const ids = new Set(world.vehicles.id.filter((_, i) => world.vehicles.alive[i]));
  for (let i = 0; i < 100 / DT; i++) world.step();
  expect(world.stats().lost).toBe(0);
  expect(world.vehicles.id.some((id, i) => world.vehicles.alive[i] && ids.has(id))).toBe(false);
});
