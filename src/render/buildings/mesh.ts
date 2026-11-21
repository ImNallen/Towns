import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { PALETTE } from '../palette';
import type { Blueprint, BuildingPick, Variant } from '../../buildings/types';

export function buildingGeometry(blueprint: Blueprint, variant: Variant): THREE.BufferGeometry {
  const pieces: THREE.BufferGeometry[] = [];
  function add(input: THREE.BufferGeometry, color: string, x: number, height: number, y: number): void {
    const geometry = input.index ? input.toNonIndexed() : input;
    if (geometry !== input) input.dispose();
    geometry.deleteAttribute('uv');
    geometry.translate(x, height, -y);
    // Reflect vertex positions and reverse triangle winding, preserving outward normals.
    if (variant.mirrored) {
      const positions = geometry.getAttribute('position');
      for (let i = 0; i < positions.count; i += 3) {
        const a = new THREE.Vector3().fromBufferAttribute(positions, i);
        const c = new THREE.Vector3().fromBufferAttribute(positions, i + 2);
        positions.setXYZ(i, -c.x, c.y, c.z);
        positions.setX(i + 1, -positions.getX(i + 1));
        positions.setXYZ(i + 2, -a.x, a.y, a.z);
      }
    }
    const tint = new THREE.Color(color);
    const colors = new Float32Array(geometry.getAttribute('position').count * 3);
    for (let i = 0; i < colors.length; i += 3) tint.toArray(colors, i);
    geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));
    geometry.computeVertexNormals();
    pieces.push(geometry);
  }
  const box = (w: number, h: number, d: number) => new THREE.BoxGeometry(w, h, d);
  for (const p of blueprint.parts) {
    switch (p.kind) {
      case 'block': case 'wing': case 'garage': {
        add(box(p.width, p.height, p.depth), PALETTE.building.walls[variant.wall], p.x, p.height / 2, p.y);
        if (p.roof.kind === 'flat') {
          add(box(p.width + 0.3, 0.25, p.depth + 0.3), PALETTE.building.roofs[variant.roof], p.x, p.height + 0.125, p.y);
          break;
        }
        if (p.roof.kind === 'sawtooth') {
          // Each bay has a broad metal pitch and a steep glazed northlight.
          const pitch = p.width / p.roof.bays;
          const peak = pitch * 0.68;
          const rise = p.roof.rise;
          const section = new THREE.Shape();
          section.moveTo(0, 0);
          section.lineTo(peak, rise);
          section.lineTo(pitch, 0);
          section.closePath();
          for (let i = 0; i < p.roof.bays; i++) {
            const left = p.x - p.width / 2 + i * pitch;
            const roof = new THREE.ExtrudeGeometry(section, { depth: p.depth, bevelEnabled: false });
            add(roof, PALETTE.building.roofs[variant.roof], left, p.height, p.y + p.depth / 2);
            const run = pitch - peak;
            const pane = box(Math.hypot(run, rise) * 0.90, 0.08, p.depth - 0.24);
            pane.rotateZ(-Math.atan2(rise, run));
            add(pane, PALETTE.building.industrial.glass, left + peak + run / 2, p.height + rise / 2 + 0.05, p.y);
          }
          break;
        }
        const alongX = p.roof.ridge === 'x';
        const length = (alongX ? p.width : p.depth) + 0.6;
        const span = (alongX ? p.depth : p.width) + 0.6;
        const l = length / 2, s = span / 2, r = p.roof.rise;
        const inset = p.roof.kind === 'hip' ? Math.min(span / 2, length / 2) : 0;
        const a = [-l, 0, -s], b = [l, 0, -s], c = [l, 0, s], d = [-l, 0, s];
        const e = [-l + inset, r, 0], f = [l - inset, r, 0];
        const roof = new THREE.BufferGeometry();
        roof.setAttribute('position', new THREE.Float32BufferAttribute([a,e,b,b,e,f,b,f,c,c,f,d,d,f,e,d,e,a].flat(), 3));
        if (!alongX) roof.rotateY(Math.PI / 2);
        add(roof, PALETTE.building.roofs[variant.roof], p.x, p.height, p.y);
        break;
      }
      case 'slab':
        add(box(p.width, p.height, p.depth), PALETTE.building.industrial[p.finish], p.x, p.base + p.height / 2, p.y);
        break;
      case 'condenser': case 'flue': {
        const { radius, base } = p;
        const flue = p.kind === 'flue';
        const height = flue ? 1.7 : 0.65;
        const body = flue ? new THREE.CylinderGeometry(radius, radius, height, 16) : box(radius * 2.5, height, radius * 2.5);
        add(body, PALETTE.building.industrial.flashing, p.x, base + height / 2, p.y);
        add(new THREE.CylinderGeometry(radius * 0.75, radius * 0.75, 0.06, 16), PALETTE.building.industrial.grille,
          p.x, base + height + 0.03, p.y);
        break;
      }
      case 'awning': {
        const stripe = p.width / 7;
        for (let i = 0; i < 7; i++) {
          const cloth = box(stripe, 0.18, p.depth);
          cloth.rotateX(0.12);
          add(cloth, i % 2 ? PALETTE.building.trim : PALETTE.building.awning,
            p.x - p.width / 2 + (i + 0.5) * stripe, p.height, p.y);
        }
        break;
      }
      case 'pool':
        add(box(p.width + 0.6, 0.15, p.depth + 0.6), PALETTE.building.trim, p.x, 0.075, p.y);
        add(box(p.width, 0.17, p.depth), PALETTE.building.pool, p.x, 0.085, p.y);
        break;
      case 'tree':
        add(new THREE.CylinderGeometry(0.18, 0.22, p.height, 6), PALETTE.building.trunk, p.x, p.height / 2, p.y);
        add(new THREE.IcosahedronGeometry(p.radius, 1), PALETTE.building.hedge, p.x, p.height, p.y);
        break;
      case 'hedge': case 'fence': case 'porch': case 'chimney':
        add(box(p.width, p.height, p.depth), p.kind === 'hedge' ? PALETTE.building.hedge : p.kind === 'chimney' ? PALETTE.building.chimney : PALETTE.building.trim, p.x, p.height / 2, p.y);
        break;
      default: { const exhaustive: never = p; throw new Error(`Unknown part ${exhaustive}`); }
    }
  }
  const merged = mergeGeometries(pieces);
  pieces.forEach((p) => p.dispose());
  if (!merged) throw new Error(`Cannot merge ${blueprint.id}`);
  return merged;
}
export interface BuildingInstance extends BuildingPick { x: number; y: number; angle: number }
/** One instanced draw per occupied blueprint/finish combination. */
export function buildBuildingLayer(instances: readonly BuildingInstance[]): THREE.Group {
  const group = new THREE.Group();
  const batches = new Map<string, BuildingInstance[]>();
  for (const instance of instances) {
    const { wall, roof, mirrored } = instance.variant;
    const key = JSON.stringify([instance.blueprint.id, wall, roof, mirrored]);
    const batch = batches.get(key) ?? [];
    batch.push(instance);
    batches.set(key, batch);
  }
  const transform = new THREE.Object3D();
  for (const batch of batches.values()) {
    const first = batch[0]!;
    const mesh = new THREE.InstancedMesh(buildingGeometry(first.blueprint, first.variant), new THREE.MeshLambertMaterial({ vertexColors: true }), batch.length);
    batch.forEach((b, i) => {
      transform.position.set(b.x, 0, -b.y);
      transform.rotation.y = b.angle;
      transform.updateMatrix();
      mesh.setMatrixAt(i, transform.matrix);
    });
    mesh.castShadow = mesh.receiveShadow = true;
    group.add(mesh);
  }
  return group;
}
