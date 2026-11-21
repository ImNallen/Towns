import { describe, expect, it } from 'vitest';
import { vec2, type Vec2 } from '../../src/sim/math/vec';
import {
  isZoneStroke, meadowLayout, meadowScenario, meadowSegments, meadowZoning, planMeadowRoad, snapToMeadowStreet,
  type MeadowEdit,
} from '../../src/sim/scenarios/meadow';
import type { Scenario } from '../../src/sim/scenarios/types';
import { DT, World } from '../../src/sim/world';
import { cellKey, decodeCellKey, findCell, type CellKey, type RoadIndex } from '../../src/sim/zoning/cells';
import { planZoneStroke, type ZoneKind, type ZoneStroke, type Zoning } from '../../src/sim/zoning/paint';

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

const cellsOf = (edits: readonly MeadowEdit[]) => meadowScenario(edits).zones!;
const zoningOf = (edits: readonly MeadowEdit[]): Zoning => meadowZoning(edits, cellsOf(edits));
const plan = (edits: readonly MeadowEdit[], touched: readonly CellKey[], zone: ZoneKind | null = 'residential') =>
  planZoneStroke(cellsOf(edits), zoningOf(edits), zone, touched);
/** What the worker does with a paint request: plan against the current state and append the stroke. */
function paint(edits: readonly MeadowEdit[], touched: readonly CellKey[], zone: ZoneKind | null = 'residential'): MeadowEdit[] {
  const result = plan(edits, touched, zone);
  if (!result.ok) throw new Error(result.reason);
  return [...edits, result.stroke];
}
const strokeAt = (edits: readonly MeadowEdit[], i: number): ZoneStroke => {
  const edit = edits.at(i)!;
  if (!isZoneStroke(edit)) throw new Error(`edit ${i} is not a stroke`);
  return edit;
};
const entries = (zoning: Zoning) => [...zoning];

/** The west starter street (RoadIndex 1) runs east along y = -8, so side 0 is north; 16 columns, 4 rows. */
const key = (column: number, row: number, road = 1, side: 0 | 1 = 0) => cellKey(road as RoadIndex, column, side, row);
const range = (from: number, to: number) => Array.from({ length: to - from + 1 }, (_, i) => from + i);
const backRow = (from: number, to: number) => range(from, to).map((c) => key(c, 3));
const block = (from: number, to: number, rows = [0, 1, 2, 3]) => range(from, to).flatMap((c) => rows.map((r) => key(c, r)));
const residential = (keys: readonly CellKey[]) => keys.map((k) => [k, 'residential']);

const stem: Gesture = [p(-65, 62), p(-65, -8)];
const isStem = (chain: readonly Vec2[]) => chain.some((q) => q.x === -65 && q.y === 62);
const roadOf = (k: CellKey) => decodeCellKey(k).road as number;
const keysOn = (edits: readonly MeadowEdit[], road: number, row?: number): CellKey[] => {
  const cells = cellsOf(edits);
  return [...cells.keys].map((k) => k as CellKey)
    .filter((k) => roadOf(k) === road && (row === undefined || decodeCellKey(k).row === row));
};
const bulldoze = (edits: readonly MeadowEdit[], match: (chain: readonly Vec2[]) => boolean): MeadowEdit[] => {
  const index = meadowSegments(edits).findIndex(match);
  expect(index).toBeGreaterThanOrEqual(0);
  return [...edits, { remove: index }];
};

describe('zone strokes', () => {
  it('a drag along the back row zones the whole block down to the street', () => {
    const edits = paint([], backRow(2, 6));
    expect(strokeAt(edits, 0)).toEqual({ zone: 'residential', cells: block(2, 6) });
    expect(entries(zoningOf(edits))).toEqual(residential(block(2, 6)));
  });

  it('a click on a front-row plot zones only that plot', () => {
    expect(strokeAt(paint([], [key(4, 0)]), 0).cells).toEqual([key(4, 0)]);
  });

  it('the eraser clears from the touched row outward', () => {
    let edits = paint([], backRow(2, 6));
    edits = paint(edits, [key(3, 1), key(4, 1)], null);
    expect(strokeAt(edits, 1)).toEqual({ zone: null, cells: block(3, 4, [1, 2, 3]) });
    expect([...zoningOf(edits).keys()]).toEqual([...block(2, 2), key(3, 0), key(4, 0), ...block(5, 6)]);
  });

  it('records only the cells it changes and refuses a stroke that changes nothing', () => {
    let edits = paint([], backRow(2, 6));
    edits = paint(edits, backRow(4, 8));
    expect(strokeAt(edits, 1).cells).toEqual(block(7, 8));
    expect(plan(edits, backRow(2, 8))).toEqual({ ok: false, reason: 'Already zoned residential.' });
    expect(plan(edits, backRow(12, 14), null)).toEqual({ ok: false, reason: 'Nothing to erase here.' });
  });

  it('ignores keys that are not live cells', () => {
    const junk = [-1, 0.5, key(5, 1) + 0.5, 2 ** 60, Number.NaN, key(0, 0, 99), key(0, 0, 0)] as CellKey[];
    expect(plan([], junk)).toEqual({ ok: false, reason: 'Drag across the plots beside a street.' });
    expect(strokeAt(paint([], [...junk, key(5, 0)]), 0).cells).toEqual([key(5, 0)]);
  });

  it('lets the last stroke that names a cell decide its zone, and undo brings back the one before', () => {
    const painted = paint([], backRow(2, 6));
    const erased = paint(painted, [key(4, 0)], null);
    const repainted = paint(erased, [key(4, 3)]);
    expect(entries(zoningOf(repainted))).toEqual(residential(block(2, 6)));
    expect(entries(zoningOf(repainted.slice(0, -1)))).toEqual(residential([...block(2, 3), ...block(5, 6)]));
    expect(entries(zoningOf(repainted.slice(0, -2)))).toEqual(residential(block(2, 6)));
  });
});

describe('strokes in the edit list', () => {
  const tee = draw([stem]);
  const bulldozed = bulldoze(draw([[p(-45, -8), p(-10, -8)], [p(-10, -8), p(20, 6)]]), (c) => c.some((q) => q.x === 20 && q.y === 6));

  it.each<[string, MeadowEdit[]]>([['the starter map', []], ['a T-junction', tee], ['a bulldozed corner', bulldozed]])(
    'leave roads, lanes and cells exactly as they were on %s', (_, base) => {
      const after = paint(base, backRow(2, 6));
      expect(isZoneStroke(after.at(-1)!)).toBe(true);
      expect(meadowScenario(after)).toEqual(meadowScenario(base));
      expect(meadowScenario(paint(after, backRow(3, 4), null))).toEqual(meadowScenario(base));
    },
  );

  it('take a RoadIndex slot, so a road after a stroke is 4 + its position', () => {
    const edits = draw([stem], paint([], backRow(2, 6)));
    expect(new Set([...cellsOf(edits).keys].map((k) => roadOf(k as CellKey)))).toEqual(new Set([1, 3, 5]));
  });

  it('are popped by undo before the road they sit on', () => {
    const painted = paint(tee, keysOn(tee, 4, 3));
    expect(zoningOf(painted).size).toBeGreaterThan(10);
    const once = painted.slice(0, -1);
    expect(once).toEqual(tee);
    expect(zoningOf(once).size).toBe(0);
    expect(isZoneStroke(painted.at(-1)!)).toBe(true);
    expect(isZoneStroke(once.at(-1)!)).toBe(false);
  });

  it('lose a bulldozed segment\'s paint, and undoing the bulldoze brings it back exactly', () => {
    const painted = paint(paint(tee, keysOn(tee, 4, 3)), backRow(0, 15));
    const before = entries(zoningOf(painted));
    expect(before.some(([k]) => roadOf(k) === 4)).toBe(true);
    const removed = bulldoze(painted, isStem);
    expect(entries(zoningOf(removed))).toEqual(before.filter(([k]) => roadOf(k) !== 4));
    expect(entries(zoningOf(removed.slice(0, -1)))).toEqual(before);
  });

  it('are hidden by a road built over them, and shown again when that road is undone or bulldozed', () => {
    const painted = paint([], backRow(0, 15));
    const before = entries(zoningOf(painted));
    expect(before).toHaveLength(64);
    const covered = draw([stem], painted);
    const hidden = entries(zoningOf(covered));
    expect(hidden.length).toBeLessThan(before.length);
    expect(hidden.every(([k]) => findCell(cellsOf(covered), k) >= 0)).toBe(true);
    expect(entries(zoningOf(covered.slice(0, -1)))).toEqual(before);
    expect(entries(zoningOf(bulldoze(covered, isStem)))).toEqual(before);
  });

  it('leave a street rebuilt where one was bulldozed unzoned', () => {
    const painted = paint(tee, keysOn(tee, 4, 3));
    const rebuilt = draw([stem], bulldoze(painted, isStem));
    expect(keysOn(rebuilt, 7).length).toBeGreaterThan(10);
    expect([...zoningOf(rebuilt).keys()].filter((k) => [4, 7].includes(roadOf(k)))).toEqual([]);
  });

  it('give the same zoning for the same edits, in ascending key order', () => {
    const edits = paint(paint(paint(tee, keysOn(tee, 4, 3)), backRow(0, 15)), [key(3, 1)], null);
    expect(entries(meadowZoning(structuredClone(edits), cellsOf(edits)))).toEqual(entries(zoningOf(edits)));
    const keys = [...zoningOf(edits).keys()];
    expect(keys.length).toBeGreaterThan(40);
    expect(keys).toEqual([...keys].sort((a, b) => a - b));
  });

  it('never reach the simulation: the hash is the same with or without strokes', () => {
    const roadsOnly = draw([[p(-65, 62), p(-65, -44)]], draw([[p(-45, -8), p(45, 8)]]));
    let withStrokes = paint([], backRow(0, 15));
    withStrokes = draw([[p(-45, -8), p(45, 8)]], withStrokes);
    withStrokes = paint(withStrokes, backRow(4, 6), null);
    withStrokes = draw([[p(-65, 62), p(-65, -44)]], withStrokes);
    withStrokes = paint(withStrokes, [keysOn(withStrokes, 7, 3)[0]!]);
    expect(withStrokes.filter(isZoneStroke)).toHaveLength(3);
    const run = (scenario: Scenario) => {
      const world = new World(scenario, 3);
      for (let t = 0; t < 120 / DT; t++) world.step();
      return world.hash();
    };
    expect(meadowScenario(withStrokes).network).toEqual(meadowScenario(roadsOnly).network);
    expect(run(meadowScenario(withStrokes))).toBe(run(meadowScenario(roadsOnly)));
  });
});
