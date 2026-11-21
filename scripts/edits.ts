/**
 * Applies a fixed sequence of Meadow Vale road edits under live traffic and reports the cars
 * each edit clears.
 *
 *   pnpm edits                 # seed 7
 *   pnpm edits --seed 3 --json
 */
import { parseArgs } from 'node:util';
import { pathToFileURL } from 'node:url';
import { distance, projectOntoSegment, type Vec2 } from '../src/sim/math/vec';
import { meadowScenario, meadowSegments, meadowSnap, planMeadowRoad, type MeadowEdit } from '../src/sim/scenarios/meadow';
import { DT, World } from '../src/sim/world';

export interface EditRow {
  edit: string;
  /** Cars on the map just before the edit. */
  active: number;
  cleared: number;
  /** Same-lane pairs closer than a car length, right after the edit and while driving on. */
  overlaps: number;
  completed: number;
}

const SETTLE_SECONDS = 45;

function build(edits: readonly MeadowEdit[], start: Vec2, end: Vec2, bend?: Vec2): MeadowEdit[] {
  const snap = (p: Vec2) => meadowSnap(edits, p, 4) ?? p;
  const plan = planMeadowRoad(edits, snap(start), snap(end), bend);
  if (!plan.ok) throw new Error(`${JSON.stringify([start, end])}: ${plan.reason}`);
  return [...edits, plan.road];
}

function bulldoze(edits: readonly MeadowEdit[], near: Vec2): MeadowEdit[] {
  let best = -1;
  let gap = 2;
  for (const [index, points] of meadowSegments(edits).entries()) {
    for (let i = 1; i < points.length; i++) {
      const d = distance(near, projectOntoSegment(near, points[i - 1]!, points[i]!));
      if (d < gap) [best, gap] = [index, d];
    }
  }
  if (best < 0) throw new Error(`No segment near ${JSON.stringify(near)}`);
  return [...edits, { remove: best }];
}

const SEQUENCE: readonly [name: string, apply: (edits: readonly MeadowEdit[]) => MeadowEdit[]][] = [
  ['connect with an arch', (e) => build(e, { x: -65, y: -8 }, { x: 65, y: 8 }, { x: 0, y: 85 })],
  ['T junction on the arch', (e) => build(e, { x: 3.54, y: 85.24 }, { x: 3.54, y: 60 })],
  ['bypass across the arch', (e) => build(e, { x: -47.27, y: 27.85 }, { x: 52.3, y: 27.74 })],
  ['four-way across the bypass', (e) => build(e, { x: -20, y: 10 }, { x: -20, y: 40 })],
  ['bulldoze a bypass segment', (e) => bulldoze(e, { x: 15, y: 27.8 })],
  ['undo the bulldozing', (e) => e.slice(0, -1)],
];

export function sameLaneOverlaps(world: World): number {
  const V = world.vehicles;
  const byLane = new Map<number, number[]>();
  for (let i = 0; i < V.highWater; i++) {
    if (!V.alive[i]) continue;
    const lane = V.lane[i]!;
    const list = byLane.get(lane);
    if (list) list.push(i);
    else byLane.set(lane, [i]);
  }
  let count = 0;
  for (const list of byLane.values()) {
    list.sort((a, b) => V.s[b]! - V.s[a]! || V.id[a]! - V.id[b]!);
    for (let k = 1; k < list.length; k++) {
      const leader = list[k - 1]!;
      if (V.s[leader]! - V.length[leader]! < V.s[list[k]!]! - 1e-4) count++;
    }
  }
  return count;
}

export function runEditSequence(seed = 7): { rows: EditRow[]; world: World } {
  let edits: MeadowEdit[] = [];
  let world = new World(meadowScenario(edits), seed);
  const rows: EditRow[] = [];
  for (const [name, apply] of SEQUENCE) {
    edits = apply(edits);
    const active = world.stats().active;
    const before = world.stats().cleared;
    const change = world.editNetwork(meadowScenario(edits));
    if (!change.ok) throw new Error(change.reason);
    world = change.world;
    let overlaps = sameLaneOverlaps(world);
    for (let t = 0; t < SETTLE_SECONDS / DT; t++) {
      world.step();
      overlaps += sameLaneOverlaps(world);
    }
    rows.push({ edit: name, active, cleared: world.stats().cleared - before, overlaps, completed: world.stats().completed });
  }
  return { rows, world };
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const { values } = parseArgs({
    args: process.argv.slice(2).filter((a) => a !== '--'),
    options: { seed: { type: 'string', default: '7' }, json: { type: 'boolean', default: false } },
  });
  const { rows, world } = runEditSequence(Number(values.seed));
  const summary = { seed: Number(values.seed), rows, stats: world.stats(), hash: world.hash() };
  if (values.json) {
    console.log(JSON.stringify(summary, null, 2));
  } else {
    console.table(rows);
    const { cleared, lost, completed } = summary.stats;
    console.log(`cleared=${cleared}  lost=${lost}  completed=${completed}  hash=${summary.hash}`);
  }
}
