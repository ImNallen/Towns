import { describe, expect, it } from 'vitest';
import { vec2, type Vec2 } from '../../src/sim/math/vec';
import {
  MEADOW_BUILD_BOUNDS, meadowLayout, meadowScenario, meadowSegments, planMeadowRoad, snapToMeadowStreet,
  type MeadowEdit, type MeadowRoad,
} from '../../src/sim/scenarios/meadow';
import type { Scenario } from '../../src/sim/scenarios/types';
import { DT, World } from '../../src/sim/world';
import { decodeCellKey, findCell, ZONE_KERB, ZONE_SLACK, type CellKey, type ZoneCells } from '../../src/sim/zoning/cells';

const p = vec2;
type Gesture = readonly [start: Vec2, end: Vec2, bend?: Vec2];

function draw(gestures: readonly Gesture[], base: readonly MeadowEdit[] = []): MeadowEdit[] {
  const edits = [...base];
  for (const [start, end, bend] of gestures) {
    const { streets } = meadowLayout(edits);
    const from = snapToMeadowStreet(streets, start, 6)?.point ?? start;
    const to = snapToMeadowStreet(streets, end, 6)?.point ?? end;
    const plan = planMeadowRoad(edits, from, to, bend);
    if (!plan.ok) throw new Error(`${JSON.stringify([start, end, bend])}: ${plan.reason}`);
    edits.push(plan.road);
  }
  return edits;
}

const zones = (edits: readonly MeadowEdit[]): ZoneCells => meadowScenario(edits).zones!;
const quad = (cells: ZoneCells, i: number): Vec2[] =>
  [0, 1, 2, 3].map((k) => p(cells.corners[i * 8 + k * 2]!, cells.corners[i * 8 + k * 2 + 1]!));
const cross = (o: Vec2, a: Vec2, b: Vec2): number => (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x);
const inside = (q: readonly Vec2[], x: Vec2): boolean => q.every((a, k) => cross(a, q[(k + 1) % 4]!, x) > 0);
const centroid = (q: readonly Vec2[]): Vec2 => p(q.reduce((s, c) => s + c.x, 0) / 4, q.reduce((s, c) => s + c.y, 0) / 4);
/** Bilinear points well inside the quad, deeper than the overlap a cell may have with its neighbours. */
const interior = (q: readonly Vec2[]): Vec2[] => [0.2, 0.5, 0.8].flatMap((u) => [0.2, 0.5, 0.8].map((v) => p(
  (1 - v) * ((1 - u) * q[0]!.x + u * q[1]!.x) + v * ((1 - u) * q[3]!.x + u * q[2]!.x),
  (1 - v) * ((1 - u) * q[0]!.y + u * q[1]!.y) + v * ((1 - u) * q[3]!.y + u * q[2]!.y),
)));
/** Points spread over the whole quad, inset only by the slack allowed against roads. */
const covering = (q: readonly Vec2[]): Vec2[] => {
  const inset = ZONE_SLACK / 4;
  const steps = [inset, 0.25, 0.5, 0.75, 1 - inset];
  return steps.flatMap((u) => steps.map((v) => p(
    (1 - v) * ((1 - u) * q[0]!.x + u * q[1]!.x) + v * ((1 - u) * q[3]!.x + u * q[2]!.x),
    (1 - v) * ((1 - u) * q[0]!.y + u * q[1]!.y) + v * ((1 - u) * q[3]!.y + u * q[2]!.y),
  )));
};

function segmentDistance(x: Vec2, ax: number, ay: number, bx: number, by: number): number {
  const dx = bx - ax;
  const dy = by - ay;
  const t = Math.max(0, Math.min(1, ((x.x - ax) * dx + (x.y - ay) * dy) / (dx * dx + dy * dy || 1)));
  return Math.hypot(ax + dx * t - x.x, ay + dy * t - x.y);
}

function violations(scenario: Scenario): string[] {
  const cells = scenario.zones!;
  const out: string[] = [];
  const quads = Array.from({ length: cells.count }, (_, i) => quad(cells, i));
  const roads = scenario.network.surfaces.filter((s) => s.style !== 'driveway');
  const blobs = [...scenario.decor.lakes, ...scenario.decor.hills];
  const b = MEADOW_BUILD_BOUNDS;
  for (const [i, q] of quads.entries()) {
    const key = cells.keys[i]! as CellKey;
    const { road, column, side, row } = decodeCellKey(key);
    if (i > 0 && !(cells.keys[i - 1]! < key)) out.push(`${key}: keys not ascending`);
    if (!q.every((c, k) => cross(c, q[(k + 1) % 4]!, q[(k + 2) % 4]!) > 0)) out.push(`${key}: not convex counter-clockwise`);
    const edges = q.map((c, k) => Math.hypot(q[(k + 1) % 4]!.x - c.x, q[(k + 1) % 4]!.y - c.y));
    if (edges.some((e) => e < 4 - 1e-9 || e > 14 + 1e-9)) out.push(`${key}: edges ${edges.map((e) => e.toFixed(2))}`);
    if (row > 0 && findCell(cells, (key - 1) as CellKey) < 0) out.push(`${key}: no front neighbour (${road}/${column}/${side}/${row})`);
    if (q.some((c) => c.x < b.minX || c.x > b.maxX || c.y < b.minY || c.y > b.maxY)) out.push(`${key}: outside the build bounds`);
    for (const blob of blobs) {
      const reach = blob.radius * 1.3;
      if (inside(q, blob) || covering(q).some((x) => Math.hypot(x.x - blob.x, x.y - blob.y) < reach)) out.push(`${key}: on a lake or hill`);
    }
    for (const surface of roads) {
      const { pts } = surface.centerline;
      for (let k = 0; k + 3 < pts.length; k += 2) {
        if (covering(q).some((x) => segmentDistance(x, pts[k]!, pts[k + 1]!, pts[k + 2]!, pts[k + 3]!) < surface.width / 2)) {
          out.push(`${key}: on ${surface.style} surface ${surface.id}`);
          break;
        }
      }
    }
  }
  const centres = quads.map(centroid);
  for (let i = 0; i < quads.length; i++) {
    for (let j = 0; j < quads.length; j++) {
      if (i === j || Math.hypot(centres[i]!.x - centres[j]!.x, centres[i]!.y - centres[j]!.y) > 20) continue;
      if (interior(quads[i]!).some((x) => inside(quads[j]!, x))) out.push(`${cells.keys[i]} overlaps ${cells.keys[j]}`);
    }
  }
  return out;
}

const starter: MeadowEdit[] = [];
const connected = draw([[p(-45, -8), p(45, 8)]]);
const LAYOUTS: [string, MeadowEdit[]][] = [
  ['the starter map', starter],
  ['a straight extension', draw([[p(-45, -8), p(-10, -8)]])],
  ['a curved road', draw([[p(-60, -6), p(40, 7), p(-10, 80)]], connected)],
  ['a rounded corner', draw([[p(-45, -8), p(-45, -45)], [p(-45, -45), p(45, 8)]])],
  ['a T-junction', draw([[p(-65, 62), p(-65, -8)]])],
  ['a four-way', draw([[p(-65, 62), p(-65, -44)]])],
  ['a click-chained corner', draw([[p(-45, -8), p(-10, -8)], [p(-10, -8), p(20, 6)], [p(20, 6), p(50, 30)], [p(50, 30), p(20, 44)]])],
  ['a grid district', draw([
    [p(-40, -6), p(-40, 90)], [p(20, 4), p(20, 90)], [p(-40, 40), p(20, 40)], [p(-40, 90), p(20, 90)],
    [p(-60, 65), p(40, 65)], [p(-10, -2), p(-10, 100)],
  ], connected)],
];

describe('zone cells', () => {
  it('lines both starter streets with 16 columns, two sides and four rows from 4.5 m off the centreline', () => {
    const cells = zones(starter);
    expect(cells.count).toBe(256);
    const perStreet = new Map<number, number>();
    for (let i = 0; i < cells.count; i++) {
      const { road, row } = decodeCellKey(cells.keys[i]! as CellKey);
      perStreet.set(road, (perStreet.get(road) ?? 0) + 1);
      const front = quad(cells, i).slice(0, 2);
      const streetY = road === 1 ? -8 : 8;
      if (row === 0) for (const c of front) expect(Math.abs(Math.abs(c.y - streetY) - ZONE_KERB)).toBeLessThan(1e-9);
    }
    expect([...perStreet]).toEqual([[1, 128], [3, 128]]);
  });

  it.each(LAYOUTS)('keep clear of roads, water, hills, the edge and each other on %s', (_, edits) => {
    const scenario = meadowScenario(edits);
    expect(scenario.zones!.count).toBeGreaterThan(200);
    expect(violations(scenario)).toEqual([]);
  });

  it('line both sides of a curve, with an unbroken front row along the outside', () => {
    const edits = draw([[p(-60, -6), p(40, 7), p(-10, 80)]], connected);
    const cells = zones(edits);
    const curve = edits.length + 3;
    const [outside, inside] = ([0, 1] as const).map((side) => {
      const columns: number[] = [];
      for (let i = 0; i < cells.count; i++) {
        const key = decodeCellKey(cells.keys[i]! as CellKey);
        if (key.road === curve && key.side === side && key.row === 0) columns.push(key.column);
      }
      return columns;
    });
    expect(inside!.length).toBeGreaterThan(10);
    // The arc turns clockwise, so its left side is the outside. Only the junction columns may be missing.
    const run = outside!.slice(1, -1);
    expect(run.length).toBeGreaterThan(15);
    expect(run.at(-1)! - run[0]! + 1).toBe(run.length);
  });

  it('are identical for the same edits', () => {
    const edits: MeadowEdit[] = [
      ...draw([[p(-60, -6), p(40, 7), p(-10, 80)], [p(70, 70), p(70, -44)]], connected),
      { remove: 2 },
    ];
    expect(zones(structuredClone(edits))).toEqual(zones(edits));
  });

  it('keep every key and corner a new T-junction does not displace', () => {
    const before = zones(starter);
    const node = p(-65, -8);
    const edits = draw([[p(-65, 62), node]]);
    const road = (edits[0] as MeadowRoad).points;
    const onRoad = (x: Vec2) => road.some((a, k) => k > 0 && segmentDistance(x, a.x, a.y, road[k - 1]!.x, road[k - 1]!.y) < 4.5);
    const after = zones(edits);
    const stem = Array.from({ length: after.count }, (_, i) => i)
      .filter((i) => decodeCellKey(after.keys[i]! as CellKey).road === edits.length + 3)
      .map((i) => quad(after, i));
    let kept = 0;
    for (let i = 0; i < before.count; i++) {
      const j = findCell(after, before.keys[i]! as CellKey);
      const q = quad(before, i);
      const c = centroid(q);
      if (j < 0) {
        const displaced = Math.hypot(c.x - node.x, c.y - node.y) < 20 || covering(q).some(onRoad)
          || stem.some((s) => interior(q).some((x) => inside(s, x)));
        expect(displaced, `${before.keys[i]} vanished`).toBe(true);
        continue;
      }
      expect(after.corners.slice(j * 8, j * 8 + 8)).toEqual(before.corners.slice(i * 8, i * 8 + 8));
      kept++;
    }
    expect(kept).toBeGreaterThan(230);
  });

  it('lets a side street front row beat the main street back rows', () => {
    const edits = draw([[p(-65, 62), p(-65, -8)]]);
    const cells = zones(edits);
    const stem = edits.length + 3;
    const owner = (x: Vec2) => {
      for (let i = 0; i < cells.count; i++) if (inside(quad(cells, i), x)) return decodeCellKey(cells.keys[i]! as CellKey);
      return undefined;
    };
    expect(owner(p(-65 + 8, -8 + 16))).toMatchObject({ road: stem, row: 0 });
    expect(owner(p(-65 - 8, -8 + 16))).toMatchObject({ road: stem, row: 0 });
  });

  it('bulldozing a segment removes only its own columns', () => {
    const edits = draw([[p(-45, -8), p(-10, -8)], [p(-10, -8), p(20, 6)]]);
    const before = zones(edits);
    const removed = edits.length + 3;
    const index = meadowSegments(edits).findIndex((chain) => chain.some((q) => q.x === 20 && q.y === 6));
    const after = zones([...edits, { remove: index }]);
    const survivors = [...before.keys.keys()].filter((i) => decodeCellKey(before.keys[i]! as CellKey).road !== removed);
    expect([...after.keys]).toEqual(survivors.map((i) => before.keys[i]));
    expect([...after.corners]).toEqual(survivors.flatMap((i) => [...before.corners.slice(i * 8, i * 8 + 8)]));
  });

  it('bulldozing a T stem keeps every other cell and gives back the mouth', () => {
    const edits = draw([[p(-65, 62), p(-65, -8)]]);
    const before = zones(edits);
    const stem = edits.length + 3;
    const index = meadowSegments(edits).findIndex((chain) => chain.some((q) => q.x === -65 && q.y === 62));
    const after = zones([...edits, { remove: index }]);
    for (let i = 0; i < before.count; i++) {
      const key = before.keys[i]! as CellKey;
      expect(findCell(after, key) >= 0).toBe(decodeCellKey(key).road !== stem);
    }
    expect(after).toEqual(zones(starter));
  });

  it('undo restores the earlier grid exactly', () => {
    const edits = draw([[p(-60, -6), p(40, 7), p(-10, 80)]], connected);
    const before = zones(edits);
    edits.push(...draw([[p(70, 70), p(70, -44)]], edits).slice(edits.length));
    expect(zones(edits)).not.toEqual(before);
    edits.pop();
    expect(zones(edits)).toEqual(before);
  });

  it('grow under the starter houses and gardens', () => {
    const scenario = meadowScenario();
    const cells = scenario.zones!;
    for (const house of scenario.decor.houses) {
      expect([...Array(cells.count).keys()].some((i) => inside(quad(cells, i), house))).toBe(true);
    }
  });

  it('leave the simulation hash unchanged', () => {
    const edits = draw([[p(-65, 62), p(-65, -44)]], connected);
    const run = (scenario: Scenario) => {
      const world = new World(scenario, 3);
      for (let t = 0; t < 120 / DT; t++) world.step();
      return world.hash();
    };
    const scenario = meadowScenario(edits);
    expect(scenario.zones!.count).toBeGreaterThan(0);
    expect(run(scenario)).toBe(run({ ...scenario, zones: undefined }));
  });
});
