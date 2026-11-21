import { polyline, sampleAt, type PathSample } from '../math/polyline';
import type { Vec2 } from '../math/vec';
import type { Surface } from '../network/types';
import type { Bounds } from '../scenarios/types';

/** Target along-street width; each road fits a whole number of columns, so the real width varies. */
export const CELL_WIDTH = 8;
export const CELL_DEPTH = 8;
export const ZONE_ROWS = 4;
/** The front row starts this far from the street centreline: half the road plus a kerb gap. */
export const ZONE_KERB = 4.5;
const MIN_EDGE = 4;
const MAX_EDGE = 14;
/** Drawn road outline beyond a surface's width (see render/roads.ts). */
const OUTLINE = 0.45;
/**
 * Penetration tolerated between a cell and a road or another cell. Above the 0.56 m sagitta of a
 * front edge on the outside of an 18 m bend, so outer cells survive the tightest curves.
 */
export const ZONE_SLACK = 0.6;
const BUCKET = 16;
/** Brush sampling step (m): shorter than any cell edge, so a drag never jumps a cell it crosses. */
const BRUSH_STEP = 1;
const COLUMN_BITS = 2 ** 16;

/** Position of a road in construction order: the starter chains, then one slot per edit. */
export type RoadIndex = number & { readonly __brand: 'RoadIndex' };
/** 0 = left of the road's direction of travel, 1 = right. */
export type Side = 0 | 1;
/**
 * (road, column, side, row) packed into one safe integer, ordered by road, then column, side and row.
 * The lattice is fitted to the road as built, so a key names the same quad in every replay that has it.
 */
export type CellKey = number & { readonly __brand: 'CellKey' };

export interface ZoneRoad {
  readonly index: RoadIndex;
  /** The whole road as built, never a split section. */
  readonly points: readonly Vec2[];
  /** Arc-length ranges of `points` still standing: ascending, merged, non-empty. */
  readonly spans: readonly (readonly [from: number, to: number])[];
}

export interface ZoneObstacles {
  /** Every surface except driveways blocks cells. */
  readonly surfaces: readonly Surface[];
  /** Lakes and hills, with the reach they keep clear. */
  readonly blobs: readonly { readonly x: number; readonly y: number; readonly radius: number }[];
  readonly bounds: Bounds;
}

/**
 * Zone cells beside every street, sorted by key. Invariants: keys strictly ascending; every cell is a
 * convex quad with edges of 4..14 m, corners counter-clockwise with 0→1 along the kerb; a row r > 0 cell
 * has its row r - 1 neighbour; no two cells overlap and no cell covers a non-driveway road surface by
 * more than ZONE_SLACK; none reaches a lake or hill; every corner is inside the bounds.
 */
export interface ZoneCells {
  readonly count: number;
  readonly keys: Float64Array;
  /** 8 numbers per cell: x0, y0 … x3, y3. */
  readonly corners: Float64Array;
}

export function cellKey(road: RoadIndex, column: number, side: Side, row: number): CellKey {
  return ((road * COLUMN_BITS + column) * 8 + side * 4 + row) as CellKey;
}

export function decodeCellKey(key: CellKey): { road: RoadIndex; column: number; side: Side; row: number } {
  const row = key % 4;
  const side = (((key - row) / 4) % 2) as Side;
  const rest = (key - row - side * 4) / 8;
  const column = rest % COLUMN_BITS;
  return { road: ((rest - column) / COLUMN_BITS) as RoadIndex, column, side, row };
}

/** Index of `key`, or -1. */
export function findCell(cells: ZoneCells, key: CellKey): number {
  let lo = 0;
  let hi = cells.count - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const k = cells.keys[mid]!;
    if (k === key) return mid;
    if (k < key) lo = mid + 1;
    else hi = mid - 1;
  }
  return -1;
}

/**
 * Keys of the cells under the segment a→b, sampled every BRUSH_STEP metres, in the order first touched.
 * Where cells overlap, the lower key wins. Roads and open ground hit nothing.
 */
export function cellsAlong(cells: ZoneCells, a: Vec2, b: Vec2): CellKey[] {
  const minX = Math.min(a.x, b.x), minY = Math.min(a.y, b.y), maxX = Math.max(a.x, b.x), maxY = Math.max(a.y, b.y);
  const near: { key: CellKey; quad: Quad }[] = [];
  for (let i = 0; i < cells.count; i++) {
    const quad = cells.corners.subarray(i * 8, i * 8 + 8);
    const [x0, y0, x1, y1] = quadBox(quad);
    if (x1 >= minX && x0 <= maxX && y1 >= minY && y0 <= maxY) near.push({ key: cells.keys[i]! as CellKey, quad });
  }
  const out: CellKey[] = [];
  if (near.length === 0) return out;
  const steps = Math.max(1, Math.ceil(Math.sqrt(sq(b.x - a.x, b.y - a.y)) / BRUSH_STEP));
  for (let s = 0; s <= steps; s++) {
    const x = a.x + ((b.x - a.x) * s) / steps;
    const y = a.y + ((b.y - a.y) * s) / steps;
    const hit = near.find((cell) => insideQuad(x, y, cell.quad));
    if (hit && !out.includes(hit.key)) out.push(hit.key);
  }
  return out;
}

type Quad = Float64Array;

interface Candidate {
  key: CellKey;
  side: Side;
  /** Boundary points and outward normals (already signed for the side) at both column ends. */
  a: Vec2;
  b: Vec2;
  na: Vec2;
  nb: Vec2;
}

export function buildZoneCells(roads: readonly ZoneRoad[], obstacles: ZoneObstacles): ZoneCells {
  const surfaces = new Buckets<Capsule>();
  for (const surface of obstacles.surfaces) {
    if (surface.style === 'driveway') continue;
    const { pts } = surface.centerline;
    const radius = surface.width / 2 + OUTLINE - ZONE_SLACK;
    for (let i = 0; i + 3 < pts.length; i += 2) {
      const capsule = { ax: pts[i]!, ay: pts[i + 1]!, bx: pts[i + 2]!, by: pts[i + 3]!, radius };
      surfaces.insert(Math.min(capsule.ax, capsule.bx) - radius, Math.min(capsule.ay, capsule.by) - radius,
        Math.max(capsule.ax, capsule.bx) + radius, Math.max(capsule.ay, capsule.by) + radius, capsule);
    }
  }
  const front = roads.flatMap((road) => columns(road));
  const cells = new Buckets<Quad>();
  const accepted: { key: CellKey; quad: Quad }[] = [];
  let open = front;
  for (let row = 0; row < ZONE_ROWS; row++) {
    const next: Candidate[] = [];
    for (const c of open) {
      const quad = cellQuad(c, row);
      if (!fits(quad, obstacles, surfaces, cells)) continue;
      const key = (c.key + row) as CellKey;
      accepted.push({ key, quad });
      cells.insert(...quadBox(quad), quad);
      next.push(c);
    }
    open = next;
  }
  accepted.sort((x, y) => x.key - y.key);
  const keys = new Float64Array(accepted.length);
  const corners = new Float64Array(accepted.length * 8);
  accepted.forEach(({ key, quad }, i) => {
    keys[i] = key;
    corners.set(quad, i * 8);
  });
  return { count: accepted.length, keys, corners };
}

/** Covered columns of one road, both sides, in priority order (column, then side). */
function columns(road: ZoneRoad): Candidate[] {
  const path = polyline(road.points);
  const count = Math.max(1, Math.round(path.length / CELL_WIDTH));
  const width = path.length / count;
  const sample: PathSample = { x: 0, y: 0, hx: 0, hy: 0 };
  const at = (s: number): Vec2 => {
    sampleAt(path, s, sample);
    return { x: sample.x, y: sample.y };
  };
  const boundaries: { p: Vec2; n: Vec2 }[] = [];
  for (let j = 0; j <= count; j++) {
    const s = j === count ? path.length : j * width;
    const behind = at(Math.max(0, s - 1));
    const ahead = at(Math.min(path.length, s + 1));
    const dx = ahead.x - behind.x;
    const dy = ahead.y - behind.y;
    const l = Math.sqrt(dx * dx + dy * dy);
    boundaries.push({ p: at(s), n: { x: -dy / l, y: dx / l } });
  }
  const out: Candidate[] = [];
  for (let column = 0; column < count; column++) {
    const from = column * width;
    const to = column === count - 1 ? path.length : (column + 1) * width;
    if (!road.spans.some(([a, b]) => a <= from + 1e-6 && to <= b + 1e-6)) continue;
    const start = boundaries[column]!;
    const end = boundaries[column + 1]!;
    for (const side of [0, 1] as const) {
      const sign = side === 0 ? 1 : -1;
      out.push({
        key: cellKey(road.index, column, side, 0), side,
        a: start.p, b: end.p,
        na: { x: start.n.x * sign, y: start.n.y * sign }, nb: { x: end.n.x * sign, y: end.n.y * sign },
      });
    }
  }
  return out;
}

/** Counter-clockwise; corners 0→1 run along the kerb. The right side walks the road backwards. */
function cellQuad(c: Candidate, row: number): Quad {
  const near = ZONE_KERB + row * CELL_DEPTH;
  const far = near + CELL_DEPTH;
  const [p, q, np, nq] = c.side === 0 ? [c.a, c.b, c.na, c.nb] : [c.b, c.a, c.nb, c.na];
  return Float64Array.of(
    p.x + np.x * near, p.y + np.y * near,
    q.x + nq.x * near, q.y + nq.y * near,
    q.x + nq.x * far, q.y + nq.y * far,
    p.x + np.x * far, p.y + np.y * far,
  );
}

function fits(quad: Quad, obstacles: ZoneObstacles, surfaces: Buckets<Capsule>, cells: Buckets<Quad>): boolean {
  if (!isConvex(quad)) return false;
  for (let i = 0; i < 4; i++) {
    const j = (i + 1) % 4;
    const edge = Math.sqrt(sq(quad[j * 2]! - quad[i * 2]!, quad[j * 2 + 1]! - quad[i * 2 + 1]!));
    if (edge < MIN_EDGE || edge > MAX_EDGE) return false;
  }
  const { minX, minY, maxX, maxY } = obstacles.bounds;
  for (let i = 0; i < 8; i += 2) {
    if (quad[i]! < minX || quad[i]! > maxX || quad[i + 1]! < minY || quad[i + 1]! > maxY) return false;
  }
  for (const blob of obstacles.blobs) {
    if (pointQuadDistance(blob.x, blob.y, quad) < blob.radius) return false;
  }
  const box = quadBox(quad);
  if (surfaces.any(...box, (c) => segmentQuadDistance(c.ax, c.ay, c.bx, c.by, quad) < c.radius)) return false;
  return !cells.any(...box, (other) => penetration(quad, other) > ZONE_SLACK);
}

interface Capsule { ax: number; ay: number; bx: number; by: number; radius: number }

/** Uniform grid that only answers "any hit?", so results never depend on bucket order. */
class Buckets<T> {
  private readonly buckets = new Map<number, T[]>();

  insert(minX: number, minY: number, maxX: number, maxY: number, item: T): void {
    this.cover(minX, minY, maxX, maxY, (key) => {
      const list = this.buckets.get(key);
      if (list) list.push(item);
      else this.buckets.set(key, [item]);
      return false;
    });
  }

  any(minX: number, minY: number, maxX: number, maxY: number, hit: (item: T) => boolean): boolean {
    return this.cover(minX, minY, maxX, maxY, (key) => this.buckets.get(key)?.some(hit) ?? false);
  }

  private cover(minX: number, minY: number, maxX: number, maxY: number, visit: (key: number) => boolean): boolean {
    for (let bx = Math.floor(minX / BUCKET); bx <= Math.floor(maxX / BUCKET); bx++) {
      for (let by = Math.floor(minY / BUCKET); by <= Math.floor(maxY / BUCKET); by++) {
        if (visit((bx + 32768) * 65536 + by + 32768)) return true;
      }
    }
    return false;
  }
}

const sq = (x: number, y: number): number => x * x + y * y;

function quadBox(q: Quad): [number, number, number, number] {
  return [
    Math.min(q[0]!, q[2]!, q[4]!, q[6]!), Math.min(q[1]!, q[3]!, q[5]!, q[7]!),
    Math.max(q[0]!, q[2]!, q[4]!, q[6]!), Math.max(q[1]!, q[3]!, q[5]!, q[7]!),
  ];
}

function isConvex(q: Quad): boolean {
  for (let i = 0; i < 4; i++) {
    const a = i * 2;
    const b = ((i + 1) % 4) * 2;
    const c = ((i + 2) % 4) * 2;
    const turn = (q[b]! - q[a]!) * (q[c + 1]! - q[b + 1]!) - (q[b + 1]! - q[a + 1]!) * (q[c]! - q[b]!);
    if (!(turn > 1e-9)) return false;
  }
  return true;
}

function insideQuad(x: number, y: number, q: Quad): boolean {
  for (let i = 0; i < 4; i++) {
    const a = i * 2;
    const b = ((i + 1) % 4) * 2;
    if ((q[b]! - q[a]!) * (y - q[a + 1]!) - (q[b + 1]! - q[a + 1]!) * (x - q[a]!) < 0) return false;
  }
  return true;
}

function pointSegmentDistance(px: number, py: number, ax: number, ay: number, bx: number, by: number): number {
  const dx = bx - ax;
  const dy = by - ay;
  const len2 = dx * dx + dy * dy;
  const t = len2 > 0 ? Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / len2)) : 0;
  return Math.sqrt(sq(ax + dx * t - px, ay + dy * t - py));
}

function pointQuadDistance(x: number, y: number, q: Quad): number {
  if (insideQuad(x, y, q)) return 0;
  let best = Infinity;
  for (let i = 0; i < 4; i++) {
    const j = (i + 1) % 4;
    best = Math.min(best, pointSegmentDistance(x, y, q[i * 2]!, q[i * 2 + 1]!, q[j * 2]!, q[j * 2 + 1]!));
  }
  return best;
}

function segmentsCross(ax: number, ay: number, bx: number, by: number, cx: number, cy: number, dx: number, dy: number): boolean {
  const d1 = (bx - ax) * (cy - ay) - (by - ay) * (cx - ax);
  const d2 = (bx - ax) * (dy - ay) - (by - ay) * (dx - ax);
  const d3 = (dx - cx) * (ay - cy) - (dy - cy) * (ax - cx);
  const d4 = (dx - cx) * (by - cy) - (dy - cy) * (bx - cx);
  return d1 * d2 < 0 && d3 * d4 < 0;
}

function segmentQuadDistance(ax: number, ay: number, bx: number, by: number, q: Quad): number {
  if (insideQuad(ax, ay, q) || insideQuad(bx, by, q)) return 0;
  let best = Infinity;
  for (let i = 0; i < 4; i++) {
    const j = (i + 1) % 4;
    const cx = q[i * 2]!, cy = q[i * 2 + 1]!, dx = q[j * 2]!, dy = q[j * 2 + 1]!;
    if (segmentsCross(ax, ay, bx, by, cx, cy, dx, dy)) return 0;
    best = Math.min(best, pointSegmentDistance(cx, cy, ax, ay, bx, by),
      pointSegmentDistance(ax, ay, cx, cy, dx, dy), pointSegmentDistance(bx, by, cx, cy, dx, dy));
  }
  return best;
}

/** Separating-axis penetration depth of two convex quads; 0 when they are apart. */
function penetration(p: Quad, q: Quad): number {
  let depth = Infinity;
  for (const quad of [p, q]) {
    for (let i = 0; i < 4; i++) {
      const j = (i + 1) % 4;
      const ex = quad[j * 2]! - quad[i * 2]!;
      const ey = quad[j * 2 + 1]! - quad[i * 2 + 1]!;
      const l = Math.sqrt(ex * ex + ey * ey);
      const nx = -ey / l;
      const ny = ex / l;
      let pMin = Infinity, pMax = -Infinity, qMin = Infinity, qMax = -Infinity;
      for (let k = 0; k < 8; k += 2) {
        const dp = p[k]! * nx + p[k + 1]! * ny;
        const dq = q[k]! * nx + q[k + 1]! * ny;
        pMin = Math.min(pMin, dp); pMax = Math.max(pMax, dp);
        qMin = Math.min(qMin, dq); qMax = Math.max(qMax, dq);
      }
      const overlap = Math.min(pMax, qMax) - Math.max(pMin, qMin);
      if (overlap <= 0) return 0;
      depth = Math.min(depth, overlap);
    }
  }
  return depth;
}
