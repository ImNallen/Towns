import { Model, VEHICLES, vehicleType } from '../vehicles/catalogue';
import type { BusinessView } from '../sim/town/town';
import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { PALETTE } from './palette';

const BASE_HEIGHT = 0.15;

interface Frame {
  slots: number;
  positions: Float32Array;
  ids: Int32Array;
  models: Uint8Array;
  paint: Uint8Array;
}

/**
 * One instanced draw call per vehicle shape. Interpolates between the last two
 * simulation frames so motion is smooth at any frame rate.
 */
export class VehicleLayer {
  readonly mesh = new THREE.Group();
  private readonly batches: THREE.InstancedMesh[];
  businesses: readonly BusinessView[] = [];
  private prev: Frame | null = null;
  private cur: Frame | null = null;
  private prevAt = 0;
  private curAt = 0;
  private readonly matrix = new THREE.Matrix4();
  private readonly position = new THREE.Vector3();
  private readonly rotation = new THREE.Quaternion();
  private readonly one = new THREE.Vector3(1, 1, 1);
  private readonly up = new THREE.Vector3(0, 1, 0);
  private readonly color = new THREE.Color();

  constructor(capacity: number) {
    const material = new THREE.MeshLambertMaterial({ vertexColors: true });
    this.batches = VEHICLES.map(type => {
      const batch = new THREE.InstancedMesh(vehicleGeometry(type), material, capacity);
      batch.count = 0;
      batch.castShadow = true;
      batch.frustumCulled = false;
      batch.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      this.mesh.add(batch);
      return batch;
    });
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
    for (const batch of this.batches) batch.count = 0;

    for (let i = 0; i < cur.slots; i++) {
      const id = cur.ids[i]!;
      if (id < 0) continue;
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
      this.place(cur.models[i]!, cur.paint[i]!, x, y, h);
    }
    for (const business of this.businesses) {
      if (!business.unloading) continue;
      const { streetX, streetY, angle, x, y } = business.lot;
      const model = business.zone === 'shops' ? Model.DeliveryVan : Model.Lorry;
      const inset = 4.6 / Math.hypot(x - streetX, y - streetY);
      const half = vehicleType(model).length / 2;
      this.place(model, vehicleType(model).colours[0], streetX + (x - streetX) * inset + Math.cos(angle) * half,
        streetY + (y - streetY) * inset + Math.sin(angle) * half, angle);
    }
    for (const batch of this.batches) {
      batch.instanceMatrix.needsUpdate = true;
      if (batch.instanceColor) batch.instanceColor.needsUpdate = true;
    }
  }

  private place(model: number, paint: number, x: number, y: number, heading: number) {
    const mesh = this.batches[model - 1]!;
    if (mesh.count >= mesh.instanceMatrix.count) return;
    const index = mesh.count++;
    this.rotation.setFromAxisAngle(this.up, heading);
    this.matrix.compose(this.position.set(x, BASE_HEIGHT, -y), this.rotation, this.one);
    mesh.setMatrixAt(index, this.matrix);
    mesh.setColorAt(index, this.color.set(PALETTE.vehicles[paint]!));
  }
}

/** Front bumper at x = 0. Each horizontal outline has clipped corners. */
export function vehicleGeometry(type: (typeof VEHICLES)[number]): THREE.BufferGeometry {
  const parts: THREE.BufferGeometry[] = [];
  function panel(front: number, length: number, width: number, floor: number, height: number, radius: number, tint: string) {
    const rear = front - length, side = width / 2;
    const path = new THREE.Shape();
    path.moveTo(front - radius, -side);
    path.quadraticCurveTo(front, -side, front, -side + radius);
    path.lineTo(front, side - radius);
    path.quadraticCurveTo(front, side, front - radius, side);
    path.lineTo(rear + radius, side);
    path.quadraticCurveTo(rear, side, rear, side - radius);
    path.lineTo(rear, -side + radius);
    path.quadraticCurveTo(rear, -side, rear + radius, -side);
    path.closePath();
    const geometry = new THREE.ExtrudeGeometry(path, { depth: height, bevelEnabled: false, curveSegments: 3 });
    geometry.rotateX(-Math.PI / 2);
    geometry.translate(0, floor, 0);
    const colour = new THREE.Color(tint);
    const rgb = new THREE.Float32BufferAttribute(new Float32Array(geometry.attributes.position.count * 3), 3);
    for (let i = 0; i < rgb.count; i++) rgb.setXYZ(i, colour.r, colour.g, colour.b);
    geometry.setAttribute('color', rgb);
    parts.push(geometry);
  }
  const { length, width, shape } = type;
  const freight = shape === 'lorry', van = shape === 'deliveryVan' || shape === 'smallVan';
  const radius = shape === 'hatch' ? 0.67 : shape === 'estate' ? 0.38 : 0.16;
  const cab = freight ? 2.25 : length;
  panel(0, cab, width, 0, 1, radius, PALETTE.light);
  if (freight || van) {
    panel(-0.22, 0.65, width - 0.2, 1, 0.35, 0.12, PALETTE.vehicleGlass);
    panel(-0.88, (freight ? cab : length) - 1.02, width - 0.12, 1, freight || shape === 'deliveryVan' ? 1.45 : 0.95, 0.16, PALETTE.light);
    if (freight) {
      panel(-2.6, length - 2.6, width, 0.35, 2.7, 0.1, PALETTE.building.industrial.flashing);
      for (let x = -3.1; x > -length + 0.3; x -= 1.25) {
        panel(x, 0.09, width - 0.16, 3.05, 0.025, 0.03, PALETTE.light);
      }
    }
  } else {
    const hood = shape === 'suv' ? 1.1 : 0.8;
    const glass = length - hood - 0.25;
    panel(-hood, glass, width - 0.16, 1, 0.35, radius, PALETTE.vehicleGlass);
    panel(-hood - 0.49, glass - 0.86, width - 0.29, 1.35, shape === 'suv' ? 0.48 : 0.22, radius / 2, PALETTE.light);
  }
  return mergeGeometries(parts)!;
}
