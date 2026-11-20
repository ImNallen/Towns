import { add, distance, dot, normalize, perp, projectOntoSegment, scale, sub, type Vec2 } from '../math/vec';

type Street = readonly Vec2[];
export interface StreetPoint {
  kind: 'tip' | 'street';
  street: Street;
  point: Vec2;
  tangent: Vec2;
}

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

export function angleGuide(streets: readonly Street[], host: StreetPoint, cursor: Vec2): AngleGuide | undefined {
  const start = host.point;
  const drag = sub(cursor, start);
  const aim = normalize(drag);
  const capture = (label: AngleGuide['label'], dir: Vec2, ref: Vec2, origin = start): AngleGuide | undefined => {
    if (dot(dir, aim) < MIN_ALIGNMENT) return undefined;
    return { label, end: add(start, scale(dir, dot(drag, dir))), direction: dir, reference: ref, origin };
  };
  if (host.kind === 'tip') return capture('Straight', host.tangent, host.tangent);

  const along = dot(host.tangent, aim) < 0 ? scale(host.tangent, -1) : host.tangent;
  const normal = perp(along);
  const across = dot(normal, aim) < 0 ? scale(normal, -1) : normal;
  const local = capture('90°', across, host.tangent) ?? capture('45°', normalize(add(along, across)), along);
  if (local) return local;

  let parallel: AngleGuide | undefined;
  let reach = PARALLEL_REACH_METRES;
  for (const street of streets) {
    if (street === host.street) continue;
    const ref = nearestPoint(street, cursor);
    if (!ref) continue;
    const gap = distance(cursor, ref.point);
    if (gap >= reach) continue;
    const dir = dot(ref.tangent, aim) < 0 ? scale(ref.tangent, -1) : ref.tangent;
    if (Math.abs(dot(dir, along)) > Math.SQRT1_2) continue;
    const match = capture('Parallel', dir, dir, ref.point);
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
  const cross = (a: Vec2, b: Vec2) => a.x * b.y - a.y * b.x;
  const street = target.street;
  if (target.kind === 'tip') {
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
