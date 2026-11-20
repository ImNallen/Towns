import { add, cross, distance, dot, normalize, perp, projectOntoSegment, scale, sub, type Vec2 } from '../math/vec';
import { segmentCrossings, segmentIntersection } from './junctions';

type Street = readonly Vec2[];
type StreetReference = { kind: 'tip' | 'street' } | { kind: 'junction'; priorityAxis: Vec2 };
export type StreetPoint = StreetReference & {
  street: Street;
  point: Vec2;
  tangent: Vec2;
};

type TangentPoint = Pick<StreetPoint, 'point' | 'tangent'>;

function nearestPoint(street: Street, cursor: Vec2): TangentPoint | undefined {
  let closest: TangentPoint | undefined;
  let best = Infinity;
  for (let i = 1; i < street.length; i++) {
    const a = street[i - 1]!;
    const edge = sub(street[i]!, a);
    const point = projectOntoSegment(cursor, a, street[i]!);
    const d = distance(point, cursor);
    if (d < best) {
      closest = { point, tangent: normalize(edge) };
      best = d;
    }
  }
  return closest;
}

export interface AngleGuide {
  label: 'Straight' | '45°' | '90°' | 'Parallel';
  end: Vec2;
  direction: Vec2;
  reference: Vec2;
  origin: Vec2;
}

const PARALLEL_REACH_METRES = 35;
const MIN_ALIGNMENT = Math.cos(5 * Math.PI / 180);

function capture(start: Vec2, cursor: Vec2, label: AngleGuide['label'], direction: Vec2, reference: Vec2, origin = start): AngleGuide | undefined {
  const drag = sub(cursor, start);
  if (dot(direction, normalize(drag)) < MIN_ALIGNMENT) return undefined;
  return { label, end: add(start, scale(direction, dot(drag, direction))), direction, reference, origin };
}

function localAngle(start: Vec2, cursor: Vec2, tangent: Vec2): AngleGuide | undefined {
  const drag = sub(cursor, start);
  const along = dot(tangent, drag) < 0 ? scale(tangent, -1) : tangent;
  const normal = perp(along);
  const across = dot(normal, drag) < 0 ? scale(normal, -1) : normal;
  return capture(start, cursor, '90°', across, tangent)
    ?? capture(start, cursor, '45°', normalize(add(along, across)), along);
}

export function crossingAngleGuide(streets: readonly Street[], start: Vec2, cursor: Vec2): AngleGuide | undefined {
  let first: { point: Vec2; street: Street } | undefined;
  for (const hit of segmentCrossings(start, cursor, streets)) {
    if (!first || distance(start, hit.point) < distance(start, first.point)) first = hit;
  }
  if (!first) return undefined;
  let closest: AngleGuide | undefined;
  for (let i = 1; i < first.street.length; i++) {
    const a = first.street[i - 1]!;
    const b = first.street[i]!;
    const guide = localAngle(start, cursor, normalize(sub(b, a)));
    if (!guide) continue;
    const origin = segmentIntersection(start, guide.end, a, b);
    if (origin && (!closest || distance(origin, first.point) < distance(closest.origin, first.point))) {
      closest = { ...guide, origin };
    }
  }
  return closest;
}

export function angleGuide(streets: readonly Street[], host: StreetPoint, cursor: Vec2): AngleGuide | undefined {
  const start = host.point;
  if (host.kind !== 'street') return capture(start, cursor, 'Straight', host.tangent, host.tangent);
  const local = localAngle(start, cursor, host.tangent);
  if (local) return local;
  const aim = normalize(sub(cursor, start));

  let parallel: AngleGuide | undefined;
  let reach = PARALLEL_REACH_METRES;
  for (const street of streets) {
    if (street === host.street) continue;
    const ref = nearestPoint(street, cursor);
    if (!ref) continue;
    const gap = distance(cursor, ref.point);
    if (gap >= reach) continue;
    const dir = dot(ref.tangent, aim) < 0 ? scale(ref.tangent, -1) : ref.tangent;
    if (Math.abs(dot(dir, host.tangent)) > Math.SQRT1_2) continue;
    const match = capture(start, cursor, 'Parallel', dir, dir, ref.point);
    if (match) {
      parallel = match;
      reach = gap;
    }
  }
  return parallel;
}

/** Keep an endpoint connection exact. On a street interior, intersect the guide with
 * the destination street near the cursor so a block can close squarely. */
export function fitGuideToStreet(guide: AngleGuide, start: Vec2, target: StreetPoint, radius: number): AngleGuide | undefined {
  const street = target.street;
  if (target.kind !== 'street') {
    const offset = sub(target.point, start);
    return Math.abs(cross(offset, guide.direction)) < 1e-6 && dot(offset, guide.direction) > 0
      ? { ...guide, end: target.point } : undefined;
  }
  let match: AngleGuide | undefined;
  let reach = radius;
  for (let i = 1; i < street.length; i++) {
    const a = street[i - 1]!;
    const edge = sub(street[i]!, a);
    const divisor = cross(guide.direction, edge);
    if (Math.abs(divisor) < 1e-9) continue;
    const t = cross(sub(a, start), guide.direction) / divisor;
    if (t < 0 || t > 1) continue;
    const end = add(a, scale(edge, t));
    const gap = distance(end, target.point);
    if (gap <= reach && dot(sub(end, start), guide.direction) > 0) {
      match = { ...guide, end };
      reach = gap;
    }
  }
  return match;
}
