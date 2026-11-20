import { add, normalize, perp, scale, sub, dot, length, type Vec2 } from './vec';

/**
 * A path sampled into straight segments, parameterised by arc length.
 * Plain typed arrays so it survives structured cloning to and from the worker.
 */
export interface Polyline {
  /** Interleaved x,y. For closed polylines the first point is repeated at the end. */
  readonly pts: Float64Array;
  /** Cumulative arc length at each point. */
  readonly cum: Float64Array;
  readonly length: number;
  readonly closed: boolean;
}

export interface PathSample {
  x: number;
  y: number;
  /** Unit heading. */
  hx: number;
  hy: number;
}

export function polyline(points: readonly Vec2[], closed = false): Polyline {
  if (points.length < 2) throw new Error('polyline needs at least 2 points');
  const n = points.length + (closed ? 1 : 0);
  const pts = new Float64Array(n * 2);
  const cum = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const p = points[i % points.length]!;
    pts[i * 2] = p.x;
    pts[i * 2 + 1] = p.y;
    if (i > 0) {
      const dx = p.x - pts[i * 2 - 2]!;
      const dy = p.y - pts[i * 2 - 1]!;
      cum[i] = cum[i - 1]! + Math.sqrt(dx * dx + dy * dy);
    }
  }
  return { pts, cum, length: cum[n - 1]!, closed };
}

/** The defining points (without the repeated closing point). */
export function polylinePoints(pl: Polyline): Vec2[] {
  const n = pl.cum.length - (pl.closed ? 1 : 0);
  const out: Vec2[] = [];
  for (let i = 0; i < n; i++) out.push({ x: pl.pts[i * 2]!, y: pl.pts[i * 2 + 1]! });
  return out;
}

export function sampleAt(pl: Polyline, s: number, out: PathSample): PathSample {
  const { pts, cum } = pl;
  const last = cum.length - 1;
  let i: number;
  if (s <= 0) {
    i = 0;
    s = 0;
  } else if (s >= pl.length) {
    i = last - 1;
    s = pl.length;
  } else {
    let lo = 0;
    let hi = last;
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if (cum[mid]! <= s) lo = mid;
      else hi = mid;
    }
    i = lo;
  }
  const x0 = pts[i * 2]!;
  const y0 = pts[i * 2 + 1]!;
  const dx = pts[i * 2 + 2]! - x0;
  const dy = pts[i * 2 + 3]! - y0;
  const seg = cum[i + 1]! - cum[i]!;
  const t = seg > 0 ? (s - cum[i]!) / seg : 0;
  out.x = x0 + dx * t;
  out.y = y0 + dy * t;
  out.hx = seg > 0 ? dx / seg : 1;
  out.hy = seg > 0 ? dy / seg : 0;
  return out;
}

export const startOf = (pl: Polyline): PathSample => sampleAt(pl, 0, { x: 0, y: 0, hx: 0, hy: 0 });
export const endOf = (pl: Polyline): PathSample => sampleAt(pl, pl.length, { x: 0, y: 0, hx: 0, hy: 0 });

export function reversePolyline(pl: Polyline): Polyline {
  return polyline(polylinePoints(pl).reverse(), pl.closed);
}

/**
 * Offset sideways. Positive `d` is to the left of the direction of travel.
 * Uses mitred vertex normals, so corners keep a constant width.
 */
export function offsetPolyline(pl: Polyline, d: number): Polyline {
  const pts = polylinePoints(pl);
  const n = pts.length;
  const out: Vec2[] = [];
  for (let i = 0; i < n; i++) {
    const p = pts[i]!;
    const prev = i > 0 ? pts[i - 1] : pl.closed ? pts[n - 1] : undefined;
    const next = i < n - 1 ? pts[i + 1] : pl.closed ? pts[0] : undefined;
    const nIn = prev ? perp(normalize(sub(p, prev))) : undefined;
    const nOut = next ? perp(normalize(sub(next, p))) : undefined;
    let normal: Vec2;
    let miter = 1;
    if (nIn && nOut) {
      const sum = add(nIn, nOut);
      normal = length(sum) > 1e-6 ? normalize(sum) : nOut;
      miter = 1 / Math.max(dot(normal, nOut), 0.25);
    } else {
      normal = (nIn ?? nOut)!;
    }
    out.push(add(p, scale(normal, d * miter)));
  }
  return polyline(out, pl.closed);
}
