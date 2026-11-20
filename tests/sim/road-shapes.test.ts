import { describe, expect, it } from 'vitest';
import { vec2, type Vec2 } from '../../src/sim/math/vec';
import { meadowLayout, meadowScenario, planMeadowRoad, snapToMeadowStreet, type MeadowEdit } from '../../src/sim/scenarios/meadow';
import { VEHICLE_LENGTH } from '../../src/sim/traffic/idm';
import { DT, World } from '../../src/sim/world';

const SNAP = 6;
type Gesture = readonly [start: Vec2, end: Vec2, bend?: Vec2];

function attempt(edits: readonly MeadowEdit[], [start, end, bend]: Gesture) {
  const { streets } = meadowLayout(edits);
  const from = snapToMeadowStreet(streets, start, SNAP)?.point ?? start;
  const to = snapToMeadowStreet(streets, end, SNAP)?.point ?? end;
  return planMeadowRoad(edits, from, to, bend);
}

function draw(gestures: readonly Gesture[], base: readonly MeadowEdit[] = []): MeadowEdit[] {
  const edits = [...base];
  for (const gesture of gestures) {
    const plan = attempt(edits, gesture);
    if (!plan.ok) throw new Error(`${JSON.stringify(gesture)}: ${plan.reason}`);
    edits.push(plan.road);
  }
  return edits;
}

function sameLaneOverlaps(world: World): number {
  const V = world.vehicles;
  const byLane = new Map<number, number[]>();
  for (let i = 0; i < V.highWater; i++) {
    if (!V.alive[i]) continue;
    byLane.set(V.lane[i]!, [...(byLane.get(V.lane[i]!) ?? []), V.s[i]!]);
  }
  let count = 0;
  for (const list of byLane.values()) {
    list.sort((a, b) => a - b);
    for (let k = 1; k < list.length; k++) if (list[k]! - list[k - 1]! < VEHICLE_LENGTH - 0.25) count++;
  }
  return count;
}

function drive(edits: readonly MeadowEdit[], seconds = 300) {
  const scenario = meadowScenario(edits);
  const world = new World(scenario, 11);
  let overlaps = 0;
  for (let t = 0; t < seconds / DT; t++) {
    world.step();
    if (t % 5 === 0) overlaps += sameLaneOverlaps(world);
  }
  return { ...world.stats(), overlaps, demand: scenario.demand.length };
}

const p = vec2;
const tips: Gesture = [p(-45, -8), p(45, 8)];
const connected = draw([tips]);

describe('road shapes players can build', () => {
  it.each<[string, readonly Gesture[], MeadowEdit[]?]>([
    ['an L from a dead end', [[p(-45, -8), p(-45, 40)], [p(-45, 40), p(45, 8)]]],
    ['a zigzag of square corners', [
      [p(-45, -8), p(-45, 20)], [p(-45, 20), p(-15, 20)], [p(-15, 20), p(-15, 50)], [p(-15, 50), p(15, 50)],
      [p(15, 50), p(45, 8)],
    ]],
    ['a U from a dead end', [[p(-45, -8), p(-45, 40)], [p(-45, 40), p(-15, 40)], [p(-15, 40), p(-15, 10)], [p(-15, 10), p(45, 8)]]],
    ['a 120° corner after a straight run', [[p(-45, -8), p(-10, -8)], [p(-10, -8), p(-30, -8 + 20 * Math.sqrt(3))], [p(-30, -8 + 20 * Math.sqrt(3)), p(45, 8)]]],
    ['a right turn off the starter street', [[p(-45, -8), p(-45, -45)], [p(-45, -45), p(45, 8)]]],
    ['corners after branching north', [
      [p(-60, -8), p(-60, 40)], [p(-60, 40), p(-20, 40)], [p(-20, 40), p(10, 70)],
    ], connected],
    ['a free road in open land', [[p(-40, 60), p(40, 60)]], connected],
    ['a free road ending as a T on a street side', [[p(0, 60), p(0, 0)]], connected],
    ['an island with corners, later tied to the street', [
      [p(-40, 60), p(40, 60)], [p(40, 60), p(40, 90)], [p(-40, 60), p(-40, 30)], [p(0, 60), p(0, 0)],
    ], connected],
    ['an island built before the towns connect', [[p(-40, 60), p(40, 60)], tips]],
    ['a grid district', [
      [p(-40, -6), p(-40, 90)], [p(20, 4), p(20, 90)], [p(-40, 40), p(20, 40)], [p(-40, 90), p(20, 90)],
      [p(-60, 65), p(40, 65)], [p(-10, -2), p(-10, 100)],
    ], connected],
  ])('%s', (_, gestures, base) => {
    const result = drive(draw(gestures, base));
    expect(result).toMatchObject({ lost: 0, overlaps: 0, demand: 2 });
    expect(result.completed).toBeGreaterThan(30);
  });
});

describe('road shapes that stay out of reach', () => {
  it.each<[string, readonly Gesture[], Gesture, string, MeadowEdit[]?]>([
    ['a 135° hairpin at a dead end', [], [p(-45, -8), p(-65, 12)], 'too sharp'],
    ['a 135° hairpin after a corner', [[p(-45, -8), p(-45, 40)]], [p(-45, 40), p(-25, 20)], 'too sharp'],
    ['a free road shorter than 12 m', [], [p(0, 60), p(10, 60)], '12 metres'],
    ['a free road into the lake', [], [p(-60, 76), p(-110, 76)], 'water'],
    ['a free road past the edge', [], [p(0, 60), p(0, 130)], 'inside the meadow'],
    ['a crossing at 30°', [], [p(-40, -40), p(20, 40)], 'at least 45°', connected],
    ['a T beside another T', [[p(0, 60), p(0, 0)]], [p(10, 60), p(10, 1)], 'Leave', connected],
    ['a free road brushing a street', [], [p(-30, 4), p(30, 10)], 'Leave space', connected],
  ])('%s', (_, gestures, last, reason, base) => {
    const plan = attempt(draw(gestures, base), last);
    expect(plan).toMatchObject({ ok: false, reason: expect.stringContaining(reason) });
  });
});
