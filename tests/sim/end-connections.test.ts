import { expect, it } from 'vitest';
import { endOf, polyline, startOf } from '../../src/sim/math/polyline';
import { cross, distance, dot, normalize, sub, vec2, type Vec2 } from '../../src/sim/math/vec';
import { squareStreetGuide } from '../../src/sim/network/angleSnap';
import { roundedEndConnection } from '../../src/sim/network/endConnection';
import { meadowScenario, meadowStreets, planMeadowRoad, snapToMeadowStreet, type MeadowRoad } from '../../src/sim/scenarios/meadow';
import { DT, World } from '../../src/sim/world';

const east = vec2(1, 0);
const north = vec2(0, 1);
const west = vec2(-1, 0);
it.each([
  [vec2(60, 30), north],
  [vec2(12, 70), west],
  [vec2(48, -90), east],
  [vec2(0, 90), east],
])('joins the exact positions with the required headings and turn radius', (end, outgoing) => {
  const start = vec2(0, 0);
  const points = roundedEndConnection(start, end, east, outgoing, 18)!;
  expect(points[0]).toEqual(start);
  expect(points.at(-1)).toEqual(end);
  const path = polyline(points);
  const first = startOf(path);
  const last = endOf(path);
  expect(first.hx).toBeCloseTo(1, 8);
  expect(dot(vec2(last.hx, last.hy), outgoing)).toBeCloseTo(1, 8);
  for (let i = 1; i < points.length - 1; i++) {
    const a = points[i - 1]!, b = points[i]!, c = points[i + 1]!;
    const incoming = normalize(sub(b, a)), leaving = normalize(sub(c, b));
    expect(distance(a, b)).toBeGreaterThan(1e-8);
    expect(dot(incoming, leaving)).toBeGreaterThan(0.99);
    expect(2 * Math.abs(cross(incoming, leaving)) / distance(a, c)).toBeLessThanOrEqual(1 / 18 + 1e-6);
  }
});

it('declines a tight U-bend and a corner behind the departure direction', () => {
  expect(roundedEndConnection(vec2(0, 0), vec2(0, 30), east, west, 18)).toBeUndefined();
  expect(roundedEndConnection(vec2(0, 0), vec2(-30, 40), east, north, 18)).toBeUndefined();
});

function extend(roads: MeadowRoad[], a: Vec2, b: Vec2) {
  const plan = planMeadowRoad(roads, a, b);
  if (!plan.ok) throw new Error(plan.reason);
  roads.push(plan.road);
  return plan;
}

it.each([false, true])('connects two staggered ends and carries traffic both ways (reverse %s)', (reverse) => {
  const roads: MeadowRoad[] = [];
  const a = vec2(-65, 45), b = vec2(65, 58);
  extend(roads, vec2(-65, -8), a);
  extend(roads, vec2(65, 8), b);
  const before = meadowScenario(roads);
  const turn = extend(roads, reverse ? b : a, reverse ? a : b);
  expect(Math.max(...turn.road.points.map(p => p.y))).toBeGreaterThan(b.y + 18);
  const scenario = meadowScenario(roads);
  expect(scenario.demand).toHaveLength(2);
  const world = new World({ ...scenario, demand: [] }, 1);
  for (const [i, entry] of scenario.demand.entries()) world.vehicles.spawn(entry.lane, 0, 8, 1 - i, 0);
  for (let tick = 0; tick < 120 / DT; tick++) world.step();
  expect(world.stats()).toMatchObject({ active: 0, completed: 2, lost: 0 });
  roads.pop();
  expect(meadowScenario(roads)).toEqual(before);
});

it('keeps the starting tip fixed and slides the landing along the parallel street to fit the bend', () => {
  const roads: MeadowRoad[] = [];
  const start = vec2(-65, 35);
  extend(roads, vec2(-65, -8), start);
  extend(roads, vec2(65, 8), vec2(65, 86));
  const chains = meadowStreets(roads);
  const source = snapToMeadowStreet(chains, start, 1)!;
  const target = snapToMeadowStreet(chains, vec2(65, 38), 1)!;
  const guide = squareStreetGuide(source, target)!;
  expect(guide.label).toBe('90° at junction');
  expect(guide.end.y).toBeGreaterThan(start.y + 18);
  const turn = extend(roads, start, guide.end);
  expect(startOf(turn.path).hy).toBeCloseTo(1, 8);
  expect(endOf(turn.path).hx).toBeCloseTo(1, 8);
  expect(meadowScenario(roads).demand).toHaveLength(2);
});

it('rejects a U-bend whose arc would leave the map even though both ends fit', () => {
  const roads: MeadowRoad[] = [];
  const a = vec2(-65, 96), b = vec2(65, 96);
  extend(roads, vec2(-65, -8), a);
  extend(roads, vec2(65, 8), b);
  expect(planMeadowRoad(roads, a, b)).toMatchObject({ ok: false, reason: expect.stringContaining('inside the meadow') });
});
