import { expect, it } from 'vitest';
import { add, distance, dot, fromAngle, normalize, perp, scale, sub, vec2 } from '../../src/sim/math/vec';
import { angleGuide, fitGuideToStreet } from '../../src/sim/network/angleSnap';
import { meadowStreets, planMeadowRoad, snapToMeadowStreet } from '../../src/sim/scenarios/meadow';

const streets = meadowStreets([]);
const start = vec2(-65, -8);
const host = snapToMeadowStreet(streets, start, 0)!;
const atAngle = (degrees: number, length: number) => scale(fromAngle(degrees * Math.PI / 180), length);

it('builds square branches using the local tangent of a curved street', () => {
  const arch = planMeadowRoad([], vec2(-45, -8), vec2(45, 8), vec2(0, 20));
  if (!arch.ok) throw new Error(arch.reason);
  const roads = [arch.road];
  const curvedStreets = meadowStreets(roads);
  const source = snapToMeadowStreet(curvedStreets, vec2(-25, 15), 20)!;
  const normal = perp(source.tangent);
  for (const side of [-1, 1]) {
    const cursor = add(source.point, add(scale(normal, side * 40), scale(source.tangent, 2)));
    const guide = angleGuide(curvedStreets, source, cursor)!;
    expect(guide.label).toBe('90°');
    const plan = planMeadowRoad(roads, source.point, guide.end);
    if (!plan.ok) throw new Error(plan.reason);
    const points = plan.road.points;
    expect(distance(points.at(-1)!, add(source.point, scale(normal, side * 40)))).toBeLessThan(1e-8);
    for (const p of points) expect(dot(sub(p, source.point), source.tangent)).toBeCloseTo(0, 8);
  }
});

it('captures diagonals on both sides and leaves other angles free', () => {
  for (const degrees of [45, 135, -135, -45]) {
    const guide = angleGuide(streets, host, add(start, atAngle(degrees + 4.9, 30)))!;
    expect(guide.label).toBe('45°');
    expect(dot(guide.direction, atAngle(degrees, 1))).toBeCloseTo(1, 10);
    expect(angleGuide(streets, host, add(start, atAngle(degrees + 5.1, 30)))).toBeUndefined();
  }
});

it('extends a tip in its outward direction for either street orientation', () => {
  for (const street of [streets[0]!, [...streets[0]!].reverse()]) {
    const host = snapToMeadowStreet([street], vec2(-45, -8), 0)!;
    expect(angleGuide([street], host, vec2(-15, -6))).toMatchObject({ label: 'Straight', end: vec2(-15, -8) });
    expect(angleGuide([street], host, vec2(-75, -6))).toBeUndefined();
  }
});

it('aligns with the closest nearby parallel street', () => {
  const ref = [vec2(-58, -1), add(vec2(-58, -1), atAngle(65, 60))];
  const farther = ref.map((p) => add(p, vec2(17, 0)));
  const cursor = add(start, atAngle(67, 45));
  const guide = angleGuide([...streets, farther, ref], host, cursor)!;
  expect(guide.label).toBe('Parallel');
  expect(dot(guide.direction, normalize(sub(ref[1]!, ref[0]!)))).toBeCloseTo(1, 10);
  expect(distance(guide.origin, cursor)).toBeLessThan(10);
  expect(angleGuide([...streets, ref.map((p) => add(p, vec2(90, 0)))], host, cursor)).toBeUndefined();
});

it('closes a square block on the destination centerline within connection range', () => {
  const target = [vec2(-110, 42), vec2(-20, 42)];
  const cursor = vec2(-62, 44);
  const guide = angleGuide(streets, host, cursor)!;
  const snapped = snapToMeadowStreet([target], cursor, 5)!;
  expect(fitGuideToStreet(guide, start, snapped, 4)?.end).toEqual(vec2(-65, 42));
  expect(fitGuideToStreet(guide, start, snapped, 2)).toBeUndefined();
});

it('keeps a compatible target tip exact and releases the angle for an offset tip', () => {
  const guide = angleGuide(streets, host, vec2(-62, 44))!;
  for (const x of [-65, -62]) {
    const tip = vec2(x, 42);
    const snap = snapToMeadowStreet([[vec2(x + 30, 42), tip]], tip, 0)!;
    const fitted = fitGuideToStreet(guide, start, snap, 4);
    if (x === -65) expect(fitted?.end).toEqual(tip);
    else expect(fitted).toBeUndefined();
  }
});
