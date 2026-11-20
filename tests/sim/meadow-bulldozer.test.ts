import { describe, expect, it } from 'vitest';
import { endOf, sampleAt, startOf } from '../../src/sim/math/polyline';
import { distance, type Vec2 } from '../../src/sim/math/vec';
import {
  meadowConnected, meadowScenario, meadowSegments, meadowSnap, meadowStreets, meadowTips, planMeadowRoad,
  type MeadowEdit,
} from '../../src/sim/scenarios/meadow';

import { World, DT } from '../../src/sim/world';

const center = { x: -65, y: -8 };
const north = { x: -65, y: 62 };
const south = { x: -65, y: -44 };
function build(edits: MeadowEdit[], from: Vec2, to: Vec2): void {
  const result = planMeadowRoad(edits, from, to);
  if (!result.ok) throw new Error(result.reason);
  edits.push(result.road);
}
function removeAt(edits: MeadowEdit[], point: Vec2): void {
  const index = meadowSegments(edits).findLastIndex((chain) => chain.some((p) => distance(p, point) < 1e-6));
  expect(index).toBeGreaterThanOrEqual(0);
  edits.push({ remove: index });
}
const connectors = (edits: MeadowEdit[]) => meadowScenario(edits).network.lanes.filter((lane) => lane.kind === 'connector');

describe('meadow bulldozer history', () => {
  it('removes older construction sections, preserves neighbors and restores exact state on undo', () => {
    const edits: MeadowEdit[] = [];
    const start = { x: -45, y: -8 };
    const middle = { x: -15, y: -2 };
    build(edits, start, middle);
    build(edits, middle, { x: 12, y: 9 });
    expect(meadowSegments(edits)).toHaveLength(4);
    const before = meadowScenario(edits);
    removeAt(edits, start);
    expect(meadowSegments(edits)).toHaveLength(3);
    expect(meadowTips(edits)).toContainEqual(middle);
    expect(meadowScenario(edits).demand).toEqual([]);
    edits.pop();
    expect(meadowScenario(edits)).toEqual(before);
    expect(meadowSegments(structuredClone(edits))).toEqual(meadowSegments(edits));
  });

  it('downgrades four-way to T and then a rounded corner without ghost junctions', () => {
    const edits: MeadowEdit[] = [];
    build(edits, north, south);
    expect(connectors(edits)).toHaveLength(12);
    removeAt(edits, south);
    expect(connectors(edits)).toHaveLength(6);
    removeAt(edits, { x: -45, y: -8 });
    const scenario = meadowScenario(edits);
    expect(connectors(edits)).toHaveLength(2);
    expect(meadowTips(edits)).toContainEqual(north);
    expect(meadowStreets(edits)).toHaveLength(3);
    for (const lane of scenario.network.lanes) {
      for (const next of lane.next) {
        expect(distance(endOf(lane.path), startOf(scenario.network.lanes[next]!.path))).toBeLessThan(1e-8);
      }
    }
    removeAt(edits, north);
    expect(connectors(edits)).toHaveLength(0);
    expect(meadowTips(edits)).toContainEqual(center);
    for (let i = 0; i < 3; i++) {
      build(edits, center, north);
      expect(connectors(edits)).toHaveLength(2);
      removeAt(edits, north);
      expect(connectors(edits)).toHaveLength(0);
    }
  });

  it('retains disconnected islands and reconnects a demolished link', () => {
    const edits: MeadowEdit[] = [];
    build(edits, { x: -45, y: -8 }, { x: -15, y: -2 });
    build(edits, { x: -15, y: -2 }, { x: 12, y: 9 });
    build(edits, { x: 12, y: 9 }, { x: 45, y: 8 });
    expect(meadowConnected(edits)).toBe(true);
    removeAt(edits, { x: -45, y: -8 });
    expect(meadowConnected(edits)).toBe(false);
    expect(meadowScenario(edits).demand).toEqual([]);
    build(edits, { x: -45, y: -8 }, { x: -15, y: -2 });
    expect(meadowConnected(edits)).toBe(true);
    expect(meadowScenario(edits).demand).toHaveLength(2);
  });

  it('reroutes a car already approaching a bulldozed shortcut onto the surviving bend', () => {
    const bend = planMeadowRoad([], { x: -65, y: -8 }, { x: 65, y: 8 }, { x: 0, y: 85 });
    if (!bend.ok) throw new Error(bend.reason);
    const edits: MeadowEdit[] = [bend.road];
    build(edits, meadowSnap(edits, { x: -47.27, y: 27.85 }, 2)!, meadowSnap(edits, { x: 52.30, y: 27.74 }, 2)!);
    const streets = meadowScenario(edits);
    const world = new World({ ...streets, demand: [] }, 7);
    const car = world.vehicles.spawn(streets.demand[0]!.lane, 2, 9, 1, 0);
    for (let i = 0; i < 30; i++) world.step();

    edits.push({ remove: meadowSegments(edits).length - 1 });
    const migration = world.editNetwork({ ...meadowScenario(edits), demand: [] });
    if (!migration.ok) throw new Error(migration.reason);
    const crossAt = (simulation: World): number => {
      let y = NaN;
      for (let i = 0; i < 100 / DT && simulation.vehicles.alive[car]; i++) {
        const lane = simulation.network.lanes[simulation.vehicles.lane[car]!]!;
        const pose = sampleAt(lane.path, simulation.vehicles.s[car]!, { x: 0, y: 0, hx: 0, hy: 0 });
        if (Math.abs(pose.x) < 1) y = pose.y;
        simulation.step();
      }
      expect(simulation.stats()).toMatchObject({ completed: 1, lost: 0 });
      return y;
    };
    expect(crossAt(world)).toBeLessThan(40);
    expect(crossAt(migration.world)).toBeGreaterThan(75);
  });

  it('opens and rebuilds a loop without losing its remaining island', () => {
    const a = { x: -20, y: -40 };
    const b = { x: 20, y: -40 };
    const c = { x: 20, y: 0 };
    const d = { x: -20, y: 0 };
    const edits: MeadowEdit[] = [
      { points: [a, b] }, { points: [b, c] }, { points: [c, d] }, { points: [d, a] },
    ];
    expect(connectors(edits)).toHaveLength(8);
    const original = meadowScenario(edits);
    edits.push({ remove: 2 });
    expect(connectors(edits)).toHaveLength(4);
    expect(meadowTips(edits)).toContainEqual(a);
    expect(meadowTips(edits)).toContainEqual(b);
    expect(meadowSegments(edits)).toHaveLength(5);
    edits.pop();
    expect(meadowScenario(edits)).toEqual(original);
    edits.push({ remove: 2 }, { points: [a, b] });
    expect(connectors(edits)).toHaveLength(8);
    expect(meadowTips(edits)).toEqual(meadowTips([]));
  });

  it('keeps a half-metre arm exposed by deleting a neighboring construction section', () => {
    const edits: MeadowEdit[] = [];
    const seam = { x: -10, y: -8 };
    const extension = { x: 25, y: -8 };
    const junction = { x: -10.5, y: -8 };
    const branch = { x: -10.5, y: 32 };
    build(edits, { x: -45, y: -8 }, seam);
    build(edits, seam, extension);
    build(edits, junction, branch);
    removeAt(edits, extension);
    const scenario = meadowScenario(edits);
    expect(connectors(edits)).toHaveLength(6);
    expect(scenario.network.lanes.filter((lane) => lane.kind === 'road' && lane.length < 0.5)).toHaveLength(2);
    expect(meadowTips(edits)).toContainEqual(seam);
    const world = new World({ ...scenario, demand: [] }, 1);
    const lane = scenario.network.lanes.find((lane) => lane.kind === 'road' && distance(startOf(lane.path), branch) < 3)!;
    const destination = world.routing.sinks.findIndex((_, index) => world.routing.canReach(index, lane.id));
    expect(destination).toBeGreaterThanOrEqual(0);
    world.vehicles.spawn(lane.id, 0, 8, destination, 0);
    for (let i = 0; i < 120 / DT; i++) world.step();
    expect(world.stats()).toMatchObject({ completed: 1, lost: 0 });
  });

  it('shrinks mouths when demolition exposes a five-metre seam beside a newer T', () => {
    const edits: MeadowEdit[] = [];
    const a = { x: -45, y: -8 };
    const seam = { x: -15, y: -8 };
    const junction = { x: -10, y: -8 };
    const branch = { x: -10, y: -50 };
    build(edits, a, seam);
    build(edits, seam, { x: 15, y: -8 });
    build(edits, { x: 15, y: -8 }, { x: 45, y: 8 });
    build(edits, junction, branch);
    edits.push({ remove: 2 });
    const scenario = meadowScenario(edits);
    expect(connectors(edits)).toHaveLength(6);
    expect(scenario.network.lanes.some((lane) => lane.kind === 'road' && lane.length < 5)).toBe(true);
    const world = new World({ ...scenario, demand: [] }, 1);
    const lane = scenario.network.lanes.find((lane) => lane.kind === 'road' && distance(startOf(lane.path), branch) < 3)!;
    const destination = world.routing.sinks.findIndex((_, index) => world.routing.canReach(index, lane.id));
    expect(destination).toBeGreaterThanOrEqual(0);
    world.vehicles.spawn(lane.id, 0, 8, destination, 0);
    for (let i = 0; i < 120 / DT; i++) world.step();
    expect(world.stats()).toMatchObject({ completed: 1, lost: 0 });
  });

  it.each([false, true])('rebuilds a surviving corner into T and four-way (reverse=%s)', (reverse) => {
    const edits: MeadowEdit[] = [];
    build(edits, north, south);
    removeAt(edits, south);
    removeAt(edits, { x: -45, y: -8 });
    expect(connectors(edits)).toHaveLength(2);
    if (reverse) build(edits, south, center);
    else build(edits, center, south);
    expect(connectors(edits)).toHaveLength(6);
    build(edits, center, { x: -45, y: -8 });
    expect(connectors(edits)).toHaveLength(12);
  });

  it('restores a removed transverse tip arm when the pointer is slightly off its axis', () => {
    const edits: MeadowEdit[] = [];
    build(edits, north, south);
    removeAt(edits, south);
    removeAt(edits, { x: -45, y: -8 });
    removeAt(edits, north);
    build(edits, center, { x: north.x + 1, y: north.y });
    expect(connectors(edits)).toHaveLength(2);
    const rebuilt = meadowSegments(edits).at(-1)!;
    expect(rebuilt[1]!.x).toBe(center.x);
  });

  it('turns an ordinary free tip into a square corner that carries traffic', () => {
    const edits: MeadowEdit[] = [];
    const corner = { x: -45, y: -8 };
    build(edits, corner, { x: -45, y: -45 });
    const built = meadowSegments(edits).at(-1)!;
    expect(built.every((p) => Math.abs(p.x - corner.x) < 1e-9)).toBe(true);
    expect(connectors(edits)).toHaveLength(2);
    build(edits, { x: -45, y: -45 }, { x: 45, y: 8 });
    const world = new World(meadowScenario(edits), 5);
    for (let i = 0; i < 300 / DT; i++) world.step();
    expect(world.stats().completed).toBeGreaterThan(40);
    expect(world.stats().lost).toBe(0);
  });

  it('protects portal approaches and ignores invalid removal indices', () => {
    expect(meadowSegments([])).toHaveLength(2);
    expect(meadowScenario([{ remove: 99 }, { remove: -1 }, { remove: 1.5 }])).toEqual(meadowScenario());
    const edits: MeadowEdit[] = [];
    build(edits, center, north);
    removeAt(edits, { x: -45, y: -8 });
    expect(meadowStreets(edits).some((chain) => chain.some((p) => p.x === -185))).toBe(true);
    const fresh: MeadowEdit[] = [{ remove: 0 }];
    expect(meadowTips(fresh)).toContainEqual({ x: -174, y: -8 });
    expect(meadowScenario(fresh).network.surfaces.filter((s) => s.style === 'driveway')).toHaveLength(6);
    build(fresh, { x: -174, y: -8 }, { x: -45, y: -8 });
    expect(meadowTips(fresh)).toEqual(meadowTips([]));
  });
});
