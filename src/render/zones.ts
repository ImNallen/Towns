import * as THREE from 'three';
import type { Vec2 } from '../sim/math/vec';
import { findCell, type ZoneCells } from '../sim/zoning/cells';
import type { LandUse, ZoneStroke, Zoning } from '../sim/zoning/paint';
import { FlatMesh, flatMaterial } from './flat';
import { PALETTE } from './palette';

/** Above the gardens (0.03), below the road outline (0.05). */
const HEIGHT = 0.04;
/** Above water (0.02) and the build boundary (0.025), below the gardens (0.03), so gardens read on top. */
const PAINT_HEIGHT = 0.028;
/** Above the grid lines, so a stroke still reads with ?zones=1. */
const PREVIEW_HEIGHT = 0.045;
/** Each cell draws its own border this far inside its edges, so neighbours read as separate plots. */
const GAP = 0.35;
const LINE = 0.3;

export function buildZoneLayer(cells: ZoneCells): THREE.Group {
  const mesh = new FlatMesh(HEIGHT);
  for (let i = 0; i < cells.count; i++) {
    const quad = cellQuad(cells, i);
    const outer = inset(quad, GAP);
    const inner = inset(quad, GAP + LINE);
    for (let k = 0; k < 4; k++) {
      const next = (k + 1) % 4;
      mesh.quad(outer[k]!, outer[next]!, inner[next]!, inner[k]!);
    }
  }
  const group = new THREE.Group();
  group.name = 'zones';
  if (mesh.empty) return group;
  const lines = new THREE.Mesh(mesh.build(), flatMaterial(PALETTE.zoneGrid));
  lines.receiveShadow = true;
  group.add(lines);
  return group;
}

export function buildZonePaint(cells: ZoneCells, zoning: Zoning): THREE.Group {
  const fills = new Map<LandUse, FlatMesh>();
  const paving = new FlatMesh(0.155);
  for (const [key, kind] of zoning) {
    if (kind === 'parking') {
      const i = findCell(cells, key);
      const [a, b, c, d] = cellQuad(cells, i);
      paving.quad(a!, b!, c!, d!);
      const dx = b!.x - a!.x, dy = b!.y - a!.y;
      const inset = ((cells.kerbs?.[i] ?? 5.5) - 3.5) / Math.hypot(dx, dy);
      const left = { x: a!.x + 0.3 * dx, y: a!.y + 0.3 * dy }, right = { x: a!.x + 0.7 * dx, y: a!.y + 0.7 * dy };
      paving.quad(left, right, { x: right.x + dy * inset, y: right.y - dx * inset }, { x: left.x + dy * inset, y: left.y - dx * inset });
      continue;
    }
    let fill = fills.get(kind);
    if (!fill) fills.set(kind, (fill = new FlatMesh(PAINT_HEIGHT)));
    const [a, b, c, d] = inset(cellQuad(cells, findCell(cells, key)), GAP);
    // Survey lines leave open ground in the middle of vacant plots.
    const outer = [a!, b!, c!, d!];
    const inner = inset(outer, 0.6);
    for (let k = 0; k < 4; k++) {
      const next = (k + 1) % 4;
      fill.quad(outer[k]!, outer[next]!, inner[next]!, inner[k]!);
    }
  }
  const group = new THREE.Group();
  group.name = 'zone-paint';
  if (!paving.empty) group.add(new THREE.Mesh(paving.build(), flatMaterial(PALETTE.parking)));
  for (const [kind, fill] of fills) {
    const mesh = new THREE.Mesh(fill.build(), flatMaterial(PALETTE.zonePaint[kind]));
    mesh.receiveShadow = true;
    group.add(mesh);
  }
  return group;
}

export function buildStrokePreview(cells: ZoneCells, stroke: ZoneStroke): THREE.Group {
  const frames = new FlatMesh(PREVIEW_HEIGHT);
  const fills = new FlatMesh(PREVIEW_HEIGHT - 0.002);
  for (const key of stroke.cells) {
    const quad = cellQuad(cells, findCell(cells, key));
    const outer = inset(quad, GAP);
    const inner = inset(quad, GAP + LINE * 2);
    for (let k = 0; k < 4; k++) {
      const next = (k + 1) % 4;
      frames.quad(outer[k]!, outer[next]!, inner[next]!, inner[k]!);
    }
    fills.quad(outer[0]!, outer[1]!, outer[2]!, outer[3]!);
  }
  const group = new THREE.Group();
  group.name = 'zone-stroke';
  const fill = stroke.zone ? PALETTE.zonePaint[stroke.zone] : PALETTE.editorInvalid;
  group.add(new THREE.Mesh(fills.build(), new THREE.MeshBasicMaterial({ color: fill, transparent: true, opacity: stroke.zone ? 1 : 0.28 })));
  group.add(new THREE.Mesh(frames.build(), new THREE.MeshBasicMaterial({ color: stroke.zone ? PALETTE.editorHandle : PALETTE.editorInvalid })));
  return group;
}

export function cellQuad(cells: ZoneCells, i: number): Vec2[] {
  return [0, 1, 2, 3].map((k) => ({ x: cells.corners[i * 8 + k * 2]!, y: cells.corners[i * 8 + k * 2 + 1]! }));
}

/** Moves every edge of a counter-clockwise convex quad inward by `d`. */
function inset(quad: readonly Vec2[], d: number): Vec2[] {
  const lines = quad.map((a, k) => {
    const b = quad[(k + 1) % 4]!;
    const l = Math.hypot(b.x - a.x, b.y - a.y);
    const n = { x: -(b.y - a.y) / l, y: (b.x - a.x) / l };
    return { p: { x: a.x + n.x * d, y: a.y + n.y * d }, dir: { x: (b.x - a.x) / l, y: (b.y - a.y) / l } };
  });
  return quad.map((_, k) => {
    const before = lines[(k + 3) % 4]!;
    const after = lines[k]!;
    const denom = before.dir.x * after.dir.y - before.dir.y * after.dir.x;
    const t = ((after.p.x - before.p.x) * after.dir.y - (after.p.y - before.p.y) * after.dir.x) / denom;
    return { x: before.p.x + before.dir.x * t, y: before.p.y + before.dir.y * t };
  });
}

export function buildParkingView(bays: import('../sim/town/town').TownView['bays'], occupancy: boolean): THREE.Group {
  const group = new THREE.Group();
  const lines = new FlatMesh(0.17), free = new FlatMesh(0.18), full = new FlatMesh(0.18);
  for (const b of bays) {
    const dx = Math.cos(b.angle), dy = Math.sin(b.angle);
    const point = (x: number, y: number) => ({ x: b.x + x * dx - y * dy, y: b.y + x * dy + y * dx });
    const rect = (mesh: FlatMesh, x: number, y: number, w: number, h: number) =>
      mesh.quad(point(x, y), point(x + w, y), point(x + w, y + h), point(x, y + h));
    if (b.kind === 'lot') {
      rect(lines, -2.55, -1.45, 5.2, 0.14);
      rect(lines, 2.52, -1.45, 0.14, 2.9);
    }
    if (occupancy) rect(b.model ? full : free, -2.65, -1.15, 5.3, 2.3);
  }
  for (const [mesh, colour] of [[lines, PALETTE.roadSurface], [free, PALETTE.parkingFree], [full, PALETTE.parkingFull]] as const) {
    if (!mesh.empty) group.add(new THREE.Mesh(mesh.build(), flatMaterial(colour)));
  }
  return group;
}
