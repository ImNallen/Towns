import { expect, it } from 'vitest';
import { endOf, polyline, startOf } from '../../src/sim/math/polyline';
import { cross, distance, dot, normalize, sub, vec2, type Vec2 } from '../../src/sim/math/vec';
import { squareStreetGuide } from '../../src/sim/network/angleSnap';
import { compactEndConnection } from '../../src/sim/network/endConnection';
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
  const points = compactEndConnection(start, end, east, outgoing, 18)!;
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
  expect(compactEndConnection(vec2(0, 0), vec2(0, 30), east, west, 18)).toBeUndefined();
  expect(compactEndConnection(vec2(0, 0), vec2(-30, 40), east, north, 18)).toBeUndefined();
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
  expect(Math.max(...turn.road.points.map(p => p.y))).toBeLessThan(b.y + 13);
  const scenario = meadowScenario(roads);
  expect(scenario.demand).toHaveLength(2);
  const world = new World({ ...scenario, demand: [], town: undefined }, 1);
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

it.each([96, 98])('fits a compact U-bend near the map edge at %s', (y) => {
  const roads: MeadowRoad[] = [];
  const a = vec2(-65, y), b = vec2(65, y);
  extend(roads, vec2(-65, -8), a);
  extend(roads, vec2(65, 8), b);
  const turn = extend(roads, a, b);
  expect(Math.max(...turn.road.points.map(p => p.y))).toBeLessThanOrEqual(109);
  expect(meadowScenario(roads).demand).toHaveLength(2);
});

it('tightens an angled connection when a gentler curve would cross the boundary', () => {
  const a = vec2(-60, 95), b = vec2(-10, 105);
  const roads: MeadowRoad[] = [
    { points: [vec2(a.x - 12, a.y - 12 * Math.sqrt(3)), a] },
    { points: [vec2(b.x + 12 * Math.sqrt(3), b.y - 12), b] },
  ];
  const turn = extend(roads, a, b);
  expect(Math.max(...turn.road.points.map(p => p.y))).toBeLessThanOrEqual(109);
});

it.each([false, true])('joins angled marked ends on clear ground and carries traffic (reverse %s)', (reverse) => {
  const roads: MeadowRoad[] = [];
  const a = vec2(-65, 35), b = vec2(50, 58);
  extend(roads, vec2(-65, -8), a);
  extend(roads, vec2(65, 8), b);
  extend(roads, reverse ? b : a, reverse ? a : b);
  const scenario = meadowScenario(roads);
  const world = new World({ ...scenario, demand: [], town: undefined }, 1);
  for (const [i, entry] of scenario.demand.entries()) world.vehicles.spawn(entry.lane, 0, 8, 1 - i, 0);
  for (let tick = 0; tick < 120 / DT; tick++) world.step();
  expect(world.stats()).toMatchObject({ active: 0, completed: 2, lost: 0 });
});

it('returns the rejected curve when even the minimum bend leaves the meadow and square corners sit too close', () => {
  const a = vec2(-65, 101), b = vec2(-45, 101);
  const roads: MeadowRoad[] = [{ points: [vec2(a.x, 60), a] }, { points: [vec2(b.x, 60), b] }];
  const rejected = planMeadowRoad(roads, a, b);
  expect(rejected).toMatchObject({ ok: false,
    reason: expect.stringContaining('leave the meadow'), points: expect.any(Array) });
  if (!rejected.ok) expect(Math.max(...rejected.points!.map(p => p.y))).toBeLessThanOrEqual(111.5);
});

it.each([0, 0.37, 1.6, 3.9])('rounds corner, U and S joins at arbitrary heading %s', (angle) => {
  const rotate = (p: Vec2): Vec2 => vec2(p.x * Math.cos(angle) - p.y * Math.sin(angle), p.x * Math.sin(angle) + p.y * Math.cos(angle));
  for (const [end, outgoing] of [[vec2(45, 38), north], [vec2(10, 65), west], [vec2(80, 35), normalize(vec2(1, 0.3))]] as const) {
    for (const reverse of [false, true]) {
      const a = rotate(vec2(0, 0)), b = rotate(end), incoming = rotate(east), leaving = rotate(outgoing);
      const points = compactEndConnection(reverse ? b : a, reverse ? a : b,
        reverse ? vec2(-leaving.x, -leaving.y) : incoming,
        reverse ? vec2(-incoming.x, -incoming.y) : leaving)!;
      expect(points).toBeDefined();
      const path = polyline(points);
      expect(dot(vec2(startOf(path).hx, startOf(path).hy), reverse ? vec2(-leaving.x, -leaving.y) : incoming)).toBeCloseTo(1, 8);
      expect(dot(vec2(endOf(path).hx, endOf(path).hy), reverse ? vec2(-incoming.x, -incoming.y) : leaving)).toBeCloseTo(1, 8);
      for (let i = 1; i < points.length - 1; i++) {
        const a = points[i - 1]!, b = points[i]!, c = points[i + 1]!;
        expect(2 * Math.abs(cross(normalize(sub(b, a)), normalize(sub(c, b)))) / distance(a, c)).toBeLessThanOrEqual(1 / 12 + 1e-6);
      }
    }
  }
});

it('still rejects an automatic join blocked by the lake', () => {
  const roads: MeadowRoad[] = [
    { points: [vec2(-165, 76), vec2(-150, 76)] },
    { points: [vec2(-30, 76), vec2(-60, 76)] },
  ];
  expect(planMeadowRoad(roads, vec2(-150, 76), vec2(-60, 76))).toMatchObject({
    ok: false, reason: expect.stringContaining('water'),
  });
});

it('preserves the gentle starter connection without overshooting its endpoints', () => {
  const turn = planMeadowRoad([], vec2(-45, -8), vec2(45, 8));
  expect(turn.ok).toBe(true);
  if (!turn.ok) return;
  expect(Math.min(...turn.road.points.map(p => p.y))).toBe(-8);
  expect(Math.max(...turn.road.points.map(p => p.y))).toBe(8);
  expect(turn.path.length).toBeLessThan(93);
});

it('joins close facing ends with a short straight segment', () => {
  const roads: MeadowRoad[] = [
    { points: [vec2(-45, 0), vec2(-0.25, 0)] },
    { points: [vec2(45, 0), vec2(0.25, 0)] },
  ];
  const turn = planMeadowRoad(roads, vec2(-0.25, 0), vec2(0.25, 0));
  expect(turn.ok).toBe(true);
  if (turn.ok) expect(turn.path.length).toBeCloseTo(0.5, 8);
});

it('uses a semicircle when the turning circles coincide exactly', () => {
  const points = compactEndConnection(vec2(0, 0), vec2(20, 0), north, vec2(0, -1), 10)!;
  expect(points).toBeDefined();
  expect(polyline(points).length).toBeCloseTo(10 * Math.PI + 1, 2);
  expect(Math.max(...points.map(p => p.y))).toBeLessThanOrEqual(10.5);
  expect(startOf(polyline(points)).hy).toBeCloseTo(1, 8);
  expect(endOf(polyline(points)).hy).toBeCloseTo(-1, 8);
});
