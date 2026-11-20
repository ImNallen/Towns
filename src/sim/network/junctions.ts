import { add, cross, distance, dot, normalize, scale, sub, type Vec2 } from '../math/vec';

export interface StreetCrossing {
  readonly point: Vec2;
  readonly priorityAxis: Vec2;
}

export function throughArms<T extends { tangent: Vec2 }>(arms: readonly T[], axis?: Vec2): readonly T[] {
  let pair = [arms[0]!, arms[1]!];
  let best = -Infinity;
  for (let i = 0; i < arms.length; i++) for (let j = i + 1; j < arms.length; j++) {
    const a = arms[i]!;
    const b = arms[j]!;
    const score = axis ? Math.abs(dot(sub(a.tangent, b.tangent), axis)) : -dot(a.tangent, b.tangent);
    if (score > best) { best = score; pair = [a, b]; }
  }
  return pair;
}

export function segmentIntersection(a: Vec2, b: Vec2, c: Vec2, d: Vec2): Vec2 | undefined {
  if (Math.min(a.x, b.x) > Math.max(c.x, d.x) || Math.max(a.x, b.x) < Math.min(c.x, d.x)
    || Math.min(a.y, b.y) > Math.max(c.y, d.y) || Math.max(a.y, b.y) < Math.min(c.y, d.y)) return undefined;
  const ab = sub(b, a);
  const cd = sub(d, c);
  const denominator = cross(ab, cd);
  if (Math.abs(denominator) < 1e-12) return undefined;
  const ac = sub(c, a);
  const t = cross(ac, cd) / denominator;
  const u = cross(ac, ab) / denominator;
  if (Math.min(t, u) < -1e-9 || Math.max(t, u) > 1 + 1e-9) return undefined;
  return add(a, scale(ab, t));
}

export function* segmentCrossings(a: Vec2, b: Vec2, streets: readonly (readonly Vec2[])[]) {
  for (const street of streets) for (let j = 1; j < street.length; j++) {
    const c = street[j - 1]!;
    const d = street[j]!;
    const point = segmentIntersection(a, b, c, d);
    if (point) yield { point, street, priorityAxis: normalize(sub(d, c)) };
  }
}

export function streetCrossings(
  points: readonly Vec2[], streets: readonly (readonly Vec2[])[],
): { ok: true; crossings: StreetCrossing[] } | { ok: false; reason: string } {
  const crossings: StreetCrossing[] = [];
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1]!;
    const b = points[i]!;
    for (const hit of segmentCrossings(a, b, streets)) {
      if (distance(hit.point, points[0]!) < 1e-6 || distance(hit.point, points[points.length - 1]!) < 1e-6) continue;
      if (Math.abs(dot(normalize(sub(b, a)), hit.priorityAxis)) > Math.SQRT1_2 + 1e-6) {
        return { ok: false, reason: 'Cross the street at an angle of at least 45°.' };
      }
      if (!crossings.some((existing) => distance(hit.point, existing.point) < 1e-6)) crossings.push({ point: hit.point, priorityAxis: hit.priorityAxis });
    }
  }
  return { ok: true, crossings };
}
