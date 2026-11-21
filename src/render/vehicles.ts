import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { PALETTE } from './palette';

const BASE_HEIGHT = 0.15;

interface Frame {
  slots: number;
  positions: Float32Array;
  ids: Int32Array;
  models: Uint8Array;
}

/**
 * All vehicles in one instanced draw call. Interpolates between the last two
 * simulation frames so motion is smooth at any frame rate.
 */
export class VehicleLayer {
  readonly mesh: THREE.InstancedMesh;
  private prev: Frame | null = null;
  private cur: Frame | null = null;
  private prevAt = 0;
  private curAt = 0;
  private readonly colouredId: Int32Array;
  private readonly matrix = new THREE.Matrix4();
  private readonly position = new THREE.Vector3();
  private readonly rotation = new THREE.Quaternion();
  private readonly one = new THREE.Vector3(1, 1, 1);
  private readonly zero = new THREE.Vector3(0, 0, 0);
  private readonly up = new THREE.Vector3(0, 1, 0);
  private readonly color = new THREE.Color();

  constructor(capacity: number) {
    const material = new THREE.MeshLambertMaterial({ vertexColors: true });
    this.mesh = new THREE.InstancedMesh(carGeometry(), material, capacity);
    this.mesh.count = 0;
    this.mesh.castShadow = true;
    this.mesh.frustumCulled = false;
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.colouredId = new Int32Array(capacity).fill(-1);
  }

  push(frame: Frame, now: number): void {
    this.prev = this.cur;
    this.prevAt = this.curAt;
    this.cur = frame;
    this.curAt = now;
  }

  update(now: number): void {
    const cur = this.cur;
    if (!cur) return;
    const prev = this.prev;
    const span = this.curAt - this.prevAt;
    const alpha = prev && span > 0 ? Math.min((now - this.curAt) / span, 1) : 1;
    const mesh = this.mesh;

    for (let i = 0; i < cur.slots; i++) {
      const id = cur.ids[i]!;
      if (id < 0) {
        this.matrix.compose(this.position.set(0, -10, 0), this.rotation.identity(), this.zero);
        mesh.setMatrixAt(i, this.matrix);
        continue;
      }
      let x = cur.positions[i * 3]!;
      let y = cur.positions[i * 3 + 1]!;
      let h = cur.positions[i * 3 + 2]!;
      if (prev && i < prev.slots && prev.ids[i] === id) {
        const px = prev.positions[i * 3]!;
        const py = prev.positions[i * 3 + 1]!;
        const ph = prev.positions[i * 3 + 2]!;
        x = px + (x - px) * alpha;
        y = py + (y - py) * alpha;
        let dh = h - ph;
        if (dh > Math.PI) dh -= Math.PI * 2;
        else if (dh < -Math.PI) dh += Math.PI * 2;
        h = ph + dh * alpha;
      }
      this.rotation.setFromAxisAngle(this.up, h);
      this.matrix.compose(this.position.set(x, BASE_HEIGHT, -y), this.rotation, this.one);
      mesh.setMatrixAt(i, this.matrix);
      if (this.colouredId[i] !== id) {
        this.colouredId[i] = id;
        // A car keeps the colour it left with, even if the household trades up mid-trip.
        const model = cur.models[i]!;
        mesh.setColorAt(i, this.color.set(model > 0
          ? PALETTE.carModels[model - 1]!
          : PALETTE.vehicles[hashId(id) % PALETTE.vehicles.length]!));
        if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
      }
    }
    mesh.count = cur.slots;
    mesh.instanceMatrix.needsUpdate = true;
  }
}

function hashId(id: number): number {
  return Math.imul(id ^ (id >>> 15), 0x2c1b3c6d) >>> 0;
}

/** Simple car: coloured body with a dark glass cabin. Front faces local +x. Origin at the front bumper. */
function carGeometry(): THREE.BufferGeometry {
  const length = 4.3;
  const body = new THREE.BoxGeometry(length, 1.1, 1.85).toNonIndexed();
  body.translate(-length / 2, 0.55, 0);
  const cabin = new THREE.BoxGeometry(2.1, 0.45, 1.6).toNonIndexed();
  cabin.translate(-length / 2 - 0.2, 1.3, 0);
  const tint = (g: THREE.BufferGeometry, hex: string): THREE.BufferGeometry => {
    const c = new THREE.Color(hex);
    const n = g.getAttribute('position').count;
    const arr = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) arr.set([c.r, c.g, c.b], i * 3);
    g.setAttribute('color', new THREE.BufferAttribute(arr, 3));
    return g;
  };
  const merged = mergeGeometries([tint(body, '#ffffff'), tint(cabin, PALETTE.vehicleGlass)]);
  if (!merged) throw new Error('car geometry merge failed');
  return merged;
}
