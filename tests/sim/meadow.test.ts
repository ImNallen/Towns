import { describe, expect, it } from 'vitest';
import { endOf, offsetPolyline, polyline, polylinePoints, startOf } from '../../src/sim/math/polyline';
import { distance, dot, normalize, sub, type Vec2 } from '../../src/sim/math/vec';
import { buildScenario } from '../../src/sim/scenarios';
import { meadowScenario, meadowTips, planMeadowRoad, type MeadowRoad } from '../../src/sim/scenarios/meadow';
import { DT, World } from '../../src/sim/world';

function place(roads: MeadowRoad[], start: Vec2, end: Vec2): MeadowRoad {
  const result = planMeadowRoad(roads, start, end);
  if (!result.ok) throw new Error(result.reason);
  roads.push(result.road);
  return result.road;
}

function run(world: World, seconds: number): void {
  for (let i = 0; i < seconds / DT; i++) world.step();
}

describe('meadow starter map', () => {
  it('registers two quiet disconnected streets and leaves the central field clear', () => {
    const scenario = buildScenario('meadow');
    expect(scenario.network.surfaces).toHaveLength(2);
    expect(meadowTips([])).toEqual([{ x: -45, y: -8 }, { x: 45, y: 8 }]);
    expect(scenario.demand).toEqual([]);
    expect(scenario.decor.houses.every((h) => Math.abs(h.x) > 75)).toBe(true);
    const world = new World(scenario, 1);
    run(world, 120);
    expect(world.stats().spawned).toBe(0);
  });

  it.each([false, true])('connects in a single drag in either direction (reverse=%s)', (reverse) => {
    const roads: MeadowRoad[] = [];
    const tips = meadowTips(roads);
    if (reverse) tips.reverse();
    place(roads, tips[0]!, tips[1]!);
    expect(meadowTips(roads)).toEqual([]);
    const scenario = meadowScenario(roads);
    expect(scenario.network.surfaces).toHaveLength(1);
    expect(scenario.network.sources).toHaveLength(2);
    expect(scenario.network.sinks).toHaveLength(2);
    expect(scenario.demand).toHaveLength(2);
    const world = new World(scenario, 3);
    for (const d of scenario.demand) {
      expect(world.routing.sinks.filter((_, i) => world.routing.canReach(i, d.lane))).toHaveLength(1);
      const lane = scenario.network.lanes[d.lane]!;
      expect(distance(startOf(lane.path), endOf(lane.path))).toBeGreaterThan(330);
    }
    run(world, 600);
    expect(world.stats().completed).toBeGreaterThan(100);
    expect(world.stats().lost).toBe(0);
    expect(world.stats().spawned).toBe(world.stats().completed + world.stats().active);
    expect(planMeadowRoad(roads, tips[0]!, tips[1]!).ok).toBe(false);
  });

  it('completes one exact end-to-end trip in each direction', () => {
    const roads: MeadowRoad[] = [];
    const tips = meadowTips(roads);
    place(roads, tips[0]!, tips[1]!);
    const scenario = meadowScenario(roads);
    const world = new World({ ...scenario, demand: [] }, 1);
    for (const source of scenario.network.sources) {
      const destination = world.routing.sinks.findIndex((_, i) => world.routing.canReach(i, source));
      expect(destination).toBeGreaterThanOrEqual(0);
      expect(world.vehicles.spawn(source, 0, 8, destination, 0)).toBeGreaterThanOrEqual(0);
    }
    run(world, 90);
    expect(world.stats().completed).toBe(2);
    expect(world.stats().active).toBe(0);
    expect(world.stats().lost).toBe(0);
  });

  it('extends both streets over several gentle segments before joining', () => {
    const roads: MeadowRoad[] = [];
    place(roads, meadowTips(roads)[0]!, { x: -20, y: -5 });
    place(roads, meadowTips(roads)[1]!, { x: 20, y: 5 });
    expect(meadowScenario(roads).demand).toEqual([]);
    place(roads, meadowTips(roads)[0]!, { x: -5, y: -2 });
    const tips = meadowTips(roads);
    place(roads, tips[1]!, tips[0]!);
    expect(meadowTips(roads)).toEqual([]);
    const world = new World(meadowScenario(roads), 7);
    run(world, 300);
    expect(world.stats().completed).toBeGreaterThan(40);
    expect(world.stats().lost).toBe(0);
  });

  it('keeps endpoint tangents, regular widths and opposite lane offsets consistent', () => {
    const roads: MeadowRoad[] = [];
    const first = place(roads, meadowTips(roads)[0]!, { x: -15, y: -2 });
    const second = place(roads, meadowTips(roads)[0]!, { x: 12, y: 9 });
    const a = endOf(polyline(first.points));
    const b = startOf(polyline(second.points));
    expect(a.hx).toBeCloseTo(b.hx, 12);
    expect(a.hy).toBeCloseTo(b.hy, 12);
    for (const offset of [-4, -1.75, 1.75, 4]) {
      const previousEnd = endOf(offsetPolyline(polyline(first.points), offset));
      const nextStart = startOf(offsetPolyline(polyline(second.points), offset));
      expect(distance(previousEnd, nextStart)).toBeLessThan(1e-10);
    }
    const surface = meadowScenario(roads).network.surfaces[0]!;
    const points = polylinePoints(surface.centerline);
    const left = polylinePoints(offsetPolyline(surface.centerline, 4));
    const right = polylinePoints(offsetPolyline(surface.centerline, -4));
    for (let i = 0; i < points.length; i++) {
      expect(distance(left[i]!, right[i]!)).toBeGreaterThanOrEqual(8 - 1e-8);
      expect(distance(left[i]!, right[i]!)).toBeLessThan(8.02);
      if (i > 0 && i < points.length - 1) {
        const incoming = normalize(sub(points[i]!, points[i - 1]!));
        const outgoing = normalize(sub(points[i + 1]!, points[i]!));
        expect(dot(incoming, outgoing)).toBeGreaterThan(0.998);
      }
    }
    const lanes = meadowScenario(roads).network.lanes;
    expect(distance(endOf(lanes[0]!.path), startOf(lanes[1]!.path))).toBeCloseTo(3.5, 8);
  });

  it.each([
    [{ x: -45, y: -8 }, { x: -44, y: -8 }],
    [{ x: -45, y: -8 }, { x: -65, y: -8 }],
    [{ x: -45, y: -8 }, { x: -35, y: 9 }],
    [{ x: -45, y: -8 }, { x: 300, y: 0 }],
    [{ x: -45, y: -8 }, { x: NaN, y: 0 }],
    [{ x: 0, y: 0 }, { x: 30, y: 0 }],
    [{ x: -45, y: -8 }, { x: 120, y: 29 }],
    [{ x: -45, y: -8 }, { x: 111, y: -78 }],
  ])('rejects invalid placement from %j to %j', (start, end) => {
    const result = planMeadowRoad([], start, end);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason.length).toBeGreaterThan(0);
  });

  it.each([
    [{ x: 45, y: 8 }, { x: -105, y: 76 }],
    [{ x: -45, y: -8 }, { x: 111, y: -78 }],
    [{ x: 45, y: 8 }, { x: -91, y: 15 }],
  ])('protects scenery from %j toward %j', (start, end) => {
    const result = planMeadowRoad([], start, end);
    expect(result).toEqual({ ok: false, reason: 'Leave room around buildings, water and hills.' });
  });

  it('rejects a near miss of the other street instead of creating a crossing', () => {
    const result = planMeadowRoad([], { x: -45, y: -8 }, { x: 60, y: 8 });
    expect(result.ok).toBe(false);
  });
});
