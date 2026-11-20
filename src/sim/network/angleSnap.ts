import { add, cross, distance, dot, normalize, perp, projectOntoSegment, scale, sub, type Vec2 } from '../math/vec';
import { END_TURN_RUN } from './endConnection';
import { segmentCrossings, segmentIntersection } from './junctions';

type Street = readonly Vec2[];
type StreetReference = { kind: 'tip' } | { kind: 'street'; segmentEnd: number } | { kind: 'junction'; priorityAxis: Vec2 };
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
  label: 'Straight' | '45°' | '90°' | '90° at both ends' | '90° at junction' | 'Parallel';
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

export function squareStreetGuide(host: StreetPoint, target: StreetPoint): AngleGuide | undefined {
  if (host.kind === 'junction' || target.kind !== 'street') return undefined;
  if (Math.abs(cross(host.tangent, target.tangent)) > 1e-6) return undefined;
  const fromTip = host.kind === 'tip';
  const drag = sub(target.point, host.point);
  if (!fromTip && Math.abs(cross(normalize(drag), host.tangent)) < MIN_ALIGNMENT) return undefined;
  const offset = dot(drag, host.tangent);
  const anchor = fromTip ? add(host.point, scale(host.tangent, Math.max(END_TURN_RUN, offset))) : host.point;
  const step = dot(sub(anchor, target.point), target.tangent) >= 0 ? 1 : -1;
  for (let i = target.segmentEnd; i > 0 && i < target.street.length; i += step) {
    const a = target.street[i - 1]!;
    const b = target.street[i]!;
    const tangent = normalize(sub(b, a));
    if (Math.abs(cross(host.tangent, tangent)) > 1e-6 || dot(tangent, target.tangent) <= 0) break;
    const end = projectOntoSegment(anchor, a, b);
    const across = sub(end, anchor);
    if (distance(end, anchor) < 1e-6) return undefined;
    if (Math.abs(dot(across, tangent)) > 1e-6) continue;
    if (fromTip) {
      if (distance(end, anchor) < END_TURN_RUN) return undefined;
      return { label: '90° at junction', origin: end, end, direction: normalize(scale(across, -1)), reference: tangent };
    }
    return { label: '90° at both ends', origin: host.point, end, direction: normalize(across), reference: host.tangent };
  }
  return undefined;
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
