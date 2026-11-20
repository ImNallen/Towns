import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import type { Vec2 } from '../sim/math/vec';
import { Rng } from '../sim/rng';
import type { Blob, Decor, Hill } from '../sim/scenarios/types';
import { FlatMesh, flatMaterial } from './flat';
import { PALETTE } from './palette';

const HILL_STEP = 2.4;

export function buildDecor(decor: Decor): THREE.Group {
  const group = new THREE.Group();
  group.name = 'decor';

  for (const lake of decor.lakes) {
    const sand = new FlatMesh(0.01);
    sand.polygon(blobPoints(lake, lake.radius + Math.min(16, lake.radius * 0.14)));
    const water = new FlatMesh(0.02);
    water.polygon(blobPoints(lake, lake.radius));
    for (const [mesh, color] of [[sand, PALETTE.sand], [water, PALETTE.water]] as const) {
      const m = new THREE.Mesh(mesh.build(), flatMaterial(color));
      m.receiveShadow = true;
      group.add(m);
    }
  }

  for (const hill of decor.hills) group.add(buildHill(hill));
  if (decor.houses.length > 0) {
    group.add(buildHouses(decor));
    addGardens(group, decor);
  }
  return group;
}

/** Organic closed outline: a circle perturbed by a few seeded harmonics. */
export function blobPoints(b: Blob, radius: number, center: Vec2 = b, wobble = 0.16, n = 120): Vec2[] {
  const rng = new Rng(b.seed);
  const harmonics = [2, 3, 4, 6].map((k) => ({ k, amp: (wobble * rng.range(0.3, 1)) / Math.sqrt(k), phase: rng.range(0, Math.PI * 2) }));
  const out: Vec2[] = [];
  for (let i = 0; i < n; i++) {
    const t = (i / n) * Math.PI * 2;
    let r = 1;
    for (const h of harmonics) r += h.amp * Math.sin(h.k * t + h.phase);
    out.push({ x: center.x + Math.cos(t) * radius * r, y: center.y + Math.sin(t) * radius * r });
  }
  return out;
}

/** Terraced hill: stacked extruded contour bands that shadow each other. */
function buildHill(hill: Hill): THREE.Group {
  const group = new THREE.Group();
  const rng = new Rng(hill.seed * 31 + 1);
  const peak = { x: hill.x + rng.range(-0.25, 0.25) * hill.radius, y: hill.y + rng.range(-0.25, 0.25) * hill.radius };
  for (let i = 0; i < hill.levels; i++) {
    const t = i / hill.levels;
    const radius = hill.radius * (1 - t * 0.82);
    const center = { x: hill.x + (peak.x - hill.x) * t, y: hill.y + (peak.y - hill.y) * t };
    const pts = blobPoints({ ...hill, seed: hill.seed + i * 17 }, radius, center, 0.18 + t * 0.06);
    const shape = new THREE.Shape(pts.map((p) => new THREE.Vector2(p.x, p.y)));
    const geometry = new THREE.ExtrudeGeometry(shape, { depth: HILL_STEP * (i + 1), bevelEnabled: false, curveSegments: 1 });
    geometry.rotateX(-Math.PI / 2); // shape (x, y) → world (x, 0, -y); extrusion → up
    const color = PALETTE.hills[Math.min(i, PALETTE.hills.length - 1)]!;
    const mesh = new THREE.Mesh(geometry, flatMaterial(color));
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    group.add(mesh);
  }
  return group;
}

/** Gable-roofed house, ridge along local x, centred at the origin on the ground. */
function houseGeometry(): THREE.BufferGeometry {
  const w = 10;
  const d = 7.5;
  const wallH = 3.2;
  const roofH = 2.8;
  const overhang = 0.5;

  const walls = new THREE.BoxGeometry(w, wallH, d).toNonIndexed();
  walls.translate(0, wallH / 2, 0);

  const half = d / 2 + overhang;
  const profile = new THREE.Shape([new THREE.Vector2(-half, 0), new THREE.Vector2(half, 0), new THREE.Vector2(0, roofH)]);
  const roof = new THREE.ExtrudeGeometry(profile, { depth: w + overhang * 2, bevelEnabled: false });
  roof.rotateY(Math.PI / 2); // profile in the z-y plane, extruded along x
  roof.translate(-(w / 2 + overhang), wallH, 0);

  const tint = (g: THREE.BufferGeometry, k: number): THREE.BufferGeometry => {
    const n = g.getAttribute('position').count;
    g.setAttribute('color', new THREE.Float32BufferAttribute(new Array(n * 3).fill(k), 3));
    return g;
  };
  const merged = mergeGeometries([tint(walls, 0.82), tint(roof, 1)]);
  if (!merged) throw new Error('house geometry merge failed');
  merged.computeVertexNormals();
  return merged;
}

function addGardens(group: THREE.Group, decor: Decor): void {
  const parcels = PALETTE.gardens.map(() => new FlatMesh(0.03));
  const planted = decor.houses.filter((house) => house.garden);
  if (!planted.length) return;
  const trees = new THREE.InstancedMesh(
    new THREE.IcosahedronGeometry(1, 1),
    new THREE.MeshLambertMaterial({ flatShading: true }), planted.length,
  );
  const crown = new THREE.Object3D();
  planted.forEach((house, i) => {
    const { minX, maxX, minY, maxY } = house.garden!;
    parcels[i % parcels.length]!.quad({ x: minX, y: minY }, { x: maxX, y: minY }, { x: maxX, y: maxY }, { x: minX, y: maxY });
    const radius = 2.2 + 0.4 * (i % 3);
    const streetSide = house.y - minY < maxY - house.y ? 1 : -1;
    crown.position.set(maxX - 3.5, 2.8, -(house.y + streetSide * (5 + i % 4)));
    crown.rotation.y = i;
    crown.scale.set(radius, radius * 1.1, radius);
    crown.updateMatrix();
    trees.setMatrixAt(i, crown.matrix);
    trees.setColorAt(i, new THREE.Color(PALETTE.orchard[i % PALETTE.orchard.length]!));
  });
  trees.castShadow = true;
  group.add(trees);
  parcels.forEach((parcel, i) => {
    if (parcel.empty) return;
    const lawn = new THREE.Mesh(parcel.build(), flatMaterial(PALETTE.gardens[i]!));
    lawn.receiveShadow = true;
    group.add(lawn);
  });
}

function buildHouses(decor: Decor): THREE.InstancedMesh {
  const material = new THREE.MeshLambertMaterial({ vertexColors: true });
  const mesh = new THREE.InstancedMesh(houseGeometry(), material, decor.houses.length);
  const m = new THREE.Matrix4();
  const q = new THREE.Quaternion();
  const up = new THREE.Vector3(0, 1, 0);
  const color = new THREE.Color();
  decor.houses.forEach((h, i) => {
    q.setFromAxisAngle(up, h.angle);
    m.compose(new THREE.Vector3(h.x, 0, -h.y), q, new THREE.Vector3(1, 1, 1));
    mesh.setMatrixAt(i, m);
    const roofs = h.garden ? PALETTE.cottageRoofs : PALETTE.houses;
    mesh.setColorAt(i, color.set(roofs[h.variant % roofs.length]!));
  });
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  return mesh;
}
