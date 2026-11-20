import * as THREE from 'three';
import { offsetPolyline, polylinePoints, sampleAt, type PathSample, type Polyline } from '../sim/math/polyline';
import type { Vec2 } from '../sim/math/vec';

/**
 * Accumulates flat, up-facing triangles at a fixed height into one geometry.
 * World (x, y) maps to Three.js (x, height, -y).
 */
export class FlatMesh {
  private readonly positions: number[] = [];
  private readonly indices: number[] = [];

  constructor(private readonly height: number) {}

  private vertex(p: Vec2): number {
    this.positions.push(p.x, this.height, -p.y);
    return this.positions.length / 3 - 1;
  }

  /** Convex quad a-b-c-d in either winding; always emitted facing up. */
  quad(a: Vec2, b: Vec2, c: Vec2, d: Vec2): void {
    const area = (b.x - a.x) * (c.y - a.y) - (c.x - a.x) * (b.y - a.y);
    const ia = this.vertex(a);
    const ib = this.vertex(b);
    const ic = this.vertex(c);
    const id = this.vertex(d);
    if (area >= 0) this.indices.push(ia, ib, ic, ia, ic, id);
    else this.indices.push(ia, ic, ib, ia, id, ic);
  }

  /** Band of constant `width` centred on a polyline. */
  ribbon(center: Polyline, width: number): void {
    const left = polylinePoints(offsetPolyline(center, width / 2));
    const right = polylinePoints(offsetPolyline(center, -width / 2));
    if (center.closed) {
      left.push(left[0]!);
      right.push(right[0]!);
    }
    const base = this.positions.length / 3;
    for (let i = 0; i < left.length; i++) {
      this.vertex(left[i]!);
      this.vertex(right[i]!);
    }
    for (let i = 0; i < left.length - 1; i++) {
      const l0 = base + i * 2;
      const r0 = l0 + 1;
      const l1 = l0 + 2;
      const r1 = l0 + 3;
      this.indices.push(l0, r0, l1, r0, r1, l1);
    }
  }

  /** Dashes of `dash` meters every `period` meters along a polyline. */
  dashes(path: Polyline, width: number, dash: number, period: number, start = 0): void {
    const a: PathSample = { x: 0, y: 0, hx: 0, hy: 0 };
    const b: PathSample = { x: 0, y: 0, hx: 0, hy: 0 };
    const w = width / 2;
    for (let s = start; s + dash <= path.length; s += period) {
      sampleAt(path, s, a);
      sampleAt(path, s + dash, b);
      const nx = -a.hy * w;
      const ny = a.hx * w;
      this.quad(
        { x: a.x - nx, y: a.y - ny },
        { x: b.x - nx, y: b.y - ny },
        { x: b.x + nx, y: b.y + ny },
        { x: a.x + nx, y: a.y + ny },
      );
    }
  }

  /** Filled polygon (triangulated with earcut). Points counter-clockwise or clockwise. */
  polygon(points: readonly Vec2[]): void {
    const base = this.positions.length / 3;
    for (const p of points) this.vertex(p);
    const tris = THREE.ShapeUtils.triangulateShape(
      points.map((p) => new THREE.Vector2(p.x, p.y)),
      [],
    );
    for (const [i, j, k] of tris) {
      // Ensure up-facing winding regardless of input orientation.
      if (THREE.ShapeUtils.isClockWise([points[i]!, points[j]!, points[k]!].map((p) => new THREE.Vector2(p.x, p.y)))) {
        this.indices.push(base + i, base + k, base + j);
      } else {
        this.indices.push(base + i, base + j, base + k);
      }
    }
  }

  get empty(): boolean {
    return this.indices.length === 0;
  }

  build(): THREE.BufferGeometry {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.positions, 3));
    const normals = new Float32Array(this.positions.length);
    for (let i = 1; i < normals.length; i += 3) normals[i] = 1;
    g.setAttribute('normal', new THREE.BufferAttribute(normals, 3));
    g.setIndex(this.indices);
    return g;
  }
}

/** Matte material that renders at exactly `color` on up-facing, unshadowed surfaces. */
export function flatMaterial(color: string): THREE.MeshLambertMaterial {
  return new THREE.MeshLambertMaterial({ color });
}
