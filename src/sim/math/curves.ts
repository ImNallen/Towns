import { distance, type Vec2 } from './vec';

/** Sample a cubic Bézier into points roughly `step` meters apart. */
export function cubicPoints(p0: Vec2, p1: Vec2, p2: Vec2, p3: Vec2, step = 1.5): Vec2[] {
  const approx = distance(p0, p1) + distance(p1, p2) + distance(p2, p3);
  const n = Math.max(4, Math.ceil(approx / step));
  const out: Vec2[] = [];
  for (let i = 0; i <= n; i++) {
    const t = i / n;
    const u = 1 - t;
    const a = u * u * u;
    const b = 3 * u * u * t;
    const c = 3 * u * t * t;
    const d = t * t * t;
    out.push({
      x: a * p0.x + b * p1.x + c * p2.x + d * p3.x,
      y: a * p0.y + b * p1.y + c * p2.y + d * p3.y,
    });
  }
  return out;
}

/**
 * Sample a circular arc counter-clockwise from angle `a0` to `a1` (a1 > a0).
 * With `includeEnd = false` the end point is omitted (useful for closed loops).
 */
export function arcPoints(c: Vec2, r: number, a0: number, a1: number, step = 1.5, includeEnd = true): Vec2[] {
  const n = Math.max(2, Math.ceil(((a1 - a0) * r) / step));
  const out: Vec2[] = [];
  const last = includeEnd ? n : n - 1;
  for (let i = 0; i <= last; i++) {
    const a = a0 + ((a1 - a0) * i) / n;
    out.push({ x: c.x + r * Math.cos(a), y: c.y + r * Math.sin(a) });
  }
  return out;
}
