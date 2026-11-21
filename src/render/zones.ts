import * as THREE from 'three';
import type { Vec2 } from '../sim/math/vec';
import type { ZoneCells } from '../sim/zoning/cells';
import { FlatMesh, flatMaterial } from './flat';
import { PALETTE } from './palette';

/** Above the gardens (0.03), below the road outline (0.05). */
const HEIGHT = 0.04;
/** Each cell draws its own border this far inside its edges, so neighbours read as separate plots. */
const GAP = 0.35;
const LINE = 0.3;

export function buildZoneLayer(cells: ZoneCells): THREE.Group {
  const mesh = new FlatMesh(HEIGHT);
  for (let i = 0; i < cells.count; i++) {
    const quad = [0, 1, 2, 3].map((k) => ({ x: cells.corners[i * 8 + k * 2]!, y: cells.corners[i * 8 + k * 2 + 1]! }));
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
