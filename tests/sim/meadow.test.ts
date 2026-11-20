import { describe, expect, it } from 'vitest';
import { endOf, offsetPolyline, polyline, polylinePoints, startOf } from '../../src/sim/math/polyline';
import { distance, dot, normalize, sub, type Vec2 } from '../../src/sim/math/vec';
import { buildScenario } from '../../src/sim/scenarios';
import { meadowConnected, meadowScenario, meadowSnap, meadowStreets, meadowTips, planMeadowRoad, type MeadowRoad } from '../../src/sim/scenarios/meadow';
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
    expect(scenario.network.surfaces.filter((s) => s.style === 'twoWay')).toHaveLength(2);
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
    expect(scenario.network.surfaces.filter((s) => s.style === 'twoWay')).toHaveLength(1);
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
    [{ x: -45, y: -8 }, { x: -65, y: 12 }],
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


describe('meadow street graph', () => {
  function curvedConnection(): MeadowRoad[] {
    const result = planMeadowRoad([], { x: -45, y: -8 }, { x: 45, y: 8 }, { x: 0, y: 20 });
    if (!result.ok) throw new Error(result.reason);
    expect(result.road.points).toContainEqual({ x: 0, y: 20 });
    expect(polylinePoints(result.path)).toEqual(result.road.points);
    return [result.road];
  }

  it('prioritizes the closest free tip, then projects to buildable street interiors', () => {
    expect(meadowSnap([], { x: -48, y: -6 }, 5)).toEqual({ x: -45, y: -8 });
    expect(meadowSnap([], { x: -44, y: -8 }, 0.5)).toBeUndefined();
    const roads = curvedConnection();
    const p = meadowSnap(roads, { x: -38, y: 0 }, 10)!;
    expect(p.x).toBeCloseTo(-35.10372686317824);
    expect(p.y).toBeCloseTo(-5.3968307544603675);
    expect(meadowSnap(roads, { x: 0, y: -90 }, 4)).toBeUndefined();
  });

  it('adds a shorter bypass with two T junctions on the same host and restores it on undo', () => {
    const roads = curvedConnection();
    const original = meadowScenario(roads);
    const start = meadowSnap(roads, { x: -38, y: 0 }, 10)!;
    const end = meadowSnap(roads, { x: 40, y: 0 }, 10)!;
    const bypass = planMeadowRoad(roads, start, end, { x: (start.x + end.x) / 2, y: -4 });
    if (!bypass.ok) throw new Error(bypass.reason);
    roads.push(bypass.road);
    expect(meadowConnected(roads)).toBe(true);
    expect(meadowTips(roads)).toEqual([]);
    const chains = meadowStreets(roads);
    expect(chains).toHaveLength(4);
    const replaced = chains.find((chain) => distance(chain[0]!, start) < 1e-6 && distance(chain.at(-1)!, end) < 1e-6)!;
    expect(bypass.path.length).toBeLessThan(polyline(replaced).length);
    const scenario = meadowScenario(structuredClone(roads));
    expect(scenario.network.surfaces[0]!.style).toBe('twoWay');
    expect(scenario.demand).toHaveLength(2);
    expect(meadowSnap(roads, start, 1)).toEqual(start);
    expect(planMeadowRoad(roads, start, { x: start.x, y: -50 }).ok).toBe(false);
    roads.pop();
    expect(meadowScenario(roads)).toEqual(original);
    roads.pop();
    expect(meadowConnected(roads)).toBe(false);
    expect(meadowTips(roads)).toHaveLength(2);
  });

  it('keeps a branch dead end valid before connecting it back to a street', () => {
    const roads = curvedConnection();
    const start = meadowSnap(roads, { x: -38, y: 0 }, 10)!;
    const branch = place(roads, start, { x: -20, y: -15 });
    expect(meadowTips(roads)).toEqual([branch.points.at(-1)]);
    const intermediate = meadowScenario(roads);
    expect(intermediate.demand).toHaveLength(2);
    expect(intermediate.network.surfaces.some((s) => s.style === 'junction')).toBe(true);
    const end = meadowSnap(roads, { x: 40, y: 0 }, 10)!;
    place(roads, branch.points.at(-1)!, end);
    expect(meadowTips(roads)).toEqual([]);
    expect(meadowScenario(roads).demand).toHaveLength(2);
  });

  it('rejects too-close junctions, unsnapped crossings, and an out-of-bounds curve', () => {
    const roads = curvedConnection();
    const start = meadowSnap(roads, { x: -38, y: 0 }, 10)!;
    const nearby = meadowSnap(roads, { x: -25, y: 0 }, 20)!;
    expect(planMeadowRoad(roads, start, nearby, { x: -30, y: -30 }).ok).toBe(false);
    expect(planMeadowRoad([], { x: -45, y: -8 }, { x: 60, y: 8 }).ok).toBe(false);
    expect(planMeadowRoad([], { x: -45, y: -8 }, { x: 45, y: 8 }, { x: 0, y: 1e10 }).ok).toBe(false);
  });

  it('supports branching before the towns connect and preserves short tip completions', () => {
    const branch: MeadowRoad[] = [];
    place(branch, { x: -65, y: -8 }, { x: -40, y: 35 });
    expect(meadowTips(branch)).toHaveLength(3);
    expect(meadowConnected(branch)).toBe(false);
    expect(meadowScenario(branch).demand).toEqual([]);
    const roads: MeadowRoad[] = [];
    place(roads, { x: -45, y: -8 }, { x: 34, y: 7 });
    const short = place(roads, { x: 34, y: 7 }, { x: 45, y: 8 });
    expect(polyline(short.points).length).toBeLessThan(12);
    expect(meadowConnected(roads)).toBe(true);
    expect(meadowScenario(roads).demand).toHaveLength(2);
  });

  it('coalesces near-equal replay endpoints into exact shared junction coordinates', () => {
    const roads = curvedConnection();
    const vertex = roads[0]!.points[30]!;
    const endpoint = { x: vertex.x + 1e-8, y: vertex.y };
    const chains = meadowStreets([...roads, { points: [endpoint, { x: endpoint.x, y: -40 }] }]);
    const incident = chains.flatMap((c) => [c[0]!, c.at(-1)!]).filter((p) => distance(p, endpoint) < 1e-6);
    expect(incident).toHaveLength(3);
    expect(incident.every((p) => p.x === endpoint.x && p.y === endpoint.y)).toBe(true);
  });
});
