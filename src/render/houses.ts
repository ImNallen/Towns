import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { polyline } from '../sim/math/polyline';
import type { Vec2 } from '../sim/math/vec';
import type { House } from '../sim/scenarios/types';
import { BLUEPRINTS } from '../buildings/catalogue';
import type { BusinessView, HouseholdView } from '../sim/town/town';
import { buildBuildingLayer, type BuildingInstance } from './buildings/mesh';
import { disposeLayer } from './dispose';
import { FlatMesh, flatMaterial } from './flat';
import { extendYard, type PaintedLand } from './yards';
import { PALETTE } from './palette';

/** A walled block with a gable roof, in the house's frame: ridge along local x or z, centred on z = 0. */
interface Block {
  minX: number;
  maxX: number;
  depth: number;
  wall: number;
  roof: number;
  ridge: 'x' | 'z';
}

/**
 * Houses by level (1..3). A bigger house grows towards local -x, over its own driveway,
 * because the garden tree stands on the +x side of the front lawn.
 */
const LEVELS: readonly (readonly Block[])[] = [
  [{ minX: -5, maxX: 5, depth: 7.5, wall: 3.2, roof: 2.8, ridge: 'x' }],
  [{ minX: -8, maxX: 4, depth: 10, wall: 4.2, roof: 3.4, ridge: 'x' }],
  [
    { minX: -8, maxX: 4, depth: 10, wall: 6.4, roof: 3.4, ridge: 'x' },
    { minX: -7, maxX: -2, depth: 14, wall: 6.4, roof: 2.8, ridge: 'z' },
  ],
];
const OVERHANG = 0.5;
const ZERO = new THREE.Matrix4().makeScale(0, 0, 0);

function tint(g: THREE.BufferGeometry, k: number): THREE.BufferGeometry {
  const n = g.getAttribute('position').count;
  g.setAttribute('color', new THREE.Float32BufferAttribute(new Array(n * 3).fill(k), 3));
  return g;
}

function houseGeometry(blocks: readonly Block[]): THREE.BufferGeometry {
  const parts = blocks.flatMap((b) => {
    const width = b.maxX - b.minX;
    const cx = (b.minX + b.maxX) / 2;
    const walls = new THREE.BoxGeometry(width, b.wall, b.depth).toNonIndexed();
    walls.translate(cx, b.wall / 2, 0);
    const [length, span] = b.ridge === 'x' ? [width, b.depth] : [b.depth, width];
    const half = span / 2 + OVERHANG;
    const profile = new THREE.Shape([new THREE.Vector2(-half, 0), new THREE.Vector2(half, 0), new THREE.Vector2(0, b.roof)]);
    const roof = new THREE.ExtrudeGeometry(profile, { depth: length + OVERHANG * 2, bevelEnabled: false });
    if (b.ridge === 'x') {
      roof.rotateY(Math.PI / 2); // profile in the z-y plane, extruded along x
      roof.translate(b.minX - OVERHANG, b.wall, 0);
    } else {
      roof.translate(cx, b.wall, -(b.depth / 2 + OVERHANG));
    }
    return [tint(walls, 0.82), tint(roof, 1)];
  });
  const merged = mergeGeometries(parts);
  if (!merged) throw new Error('house geometry merge failed');
  merged.computeVertexNormals();
  return merged;
}

/** Where `p` falls in the house's frame (x along the ridge). */
function local(house: House, p: Vec2): Vec2 {
  const dx = p.x - house.x;
  const dy = p.y - house.y;
  const c = Math.cos(house.angle);
  const s = Math.sin(house.angle);
  return { x: dx * c + dy * s, y: -dx * s + dy * c };
}

/**
 * Every house on the map, drawn at its level, plus the outline of the selected parcel.
 * One instanced mesh per level; a house is visible in exactly one of them.
 */
export class HouseLayer {
  readonly group = new THREE.Group();
  private readonly meshes: THREE.InstancedMesh[];
  private readonly levels: Uint8Array;
  private grown = new Map<number, NonNullable<HouseholdView['lot']>>();
  private land?: PaintedLand;
  private drawnLand?: PaintedLand;
  private grownLayer = new THREE.Group();
  private selected: number | null = null;
  private selection: THREE.Mesh | null = null;

  constructor(private readonly houses: readonly House[]) {
    this.group.name = 'houses';
    const material = new THREE.MeshLambertMaterial({ vertexColors: true });
    const color = new THREE.Color();
    this.meshes = LEVELS.map((blocks) => {
      const mesh = new THREE.InstancedMesh(houseGeometry(blocks), material, houses.length);
      houses.forEach((h, i) => {
        const roofs = h.garden ? PALETTE.cottageRoofs : PALETTE.houses;
        mesh.setColorAt(i, color.set(roofs[h.variant % roofs.length]!));
      });
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      // Instances appear and vanish as houses change level, so a cached bounding sphere would go stale.
      mesh.frustumCulled = false;
      this.group.add(mesh);
      return mesh;
    });
    this.levels = new Uint8Array(houses.length);
    houses.forEach((_, i) => this.setLevel(i, 1));
  }

  /** Show house `index` at `level` (1..3). */
  setLevel(index: number, level: number): void {
    const clamped = Math.max(1, Math.min(LEVELS.length, level));
    if (this.levels[index] === clamped) return;
    this.levels[index] = clamped;
    const house = this.houses[index]!;
    const matrix = new THREE.Matrix4().compose(
      new THREE.Vector3(house.x, 0, -house.y),
      new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), house.angle),
      new THREE.Vector3(1, 1, 1),
    );
    this.meshes.forEach((mesh, k) => {
      mesh.setMatrixAt(index, k === clamped - 1 ? matrix : ZERO);
      mesh.instanceMatrix.needsUpdate = true;
    });
  }

  setPaint(land: PaintedLand): void {
    this.land = land;
  }

  update(households: HouseholdView[], businesses: BusinessView[]): void {
    const grown = new Map<number, NonNullable<HouseholdView['lot']>>();
    for (const h of households) {
      if (h.lot) grown.set(h.home, h.lot);
      else this.setLevel(h.home, h.level);
    }
    for (const business of businesses) grown.set(business.home, business.lot);
    if (this.drawnLand === this.land && grown.size === this.grown.size && [...grown].every(([id, lot]) => {
      const old = this.grown.get(id);
      return old?.key === lot.key && old.x === lot.x && old.y === lot.y && old.design === lot.design && old.columns === lot.columns && old.rows === lot.rows;
    })) return;
    this.drawnLand = this.land;
    this.grown = grown;
    disposeLayer(this.grownLayer);
    const instances: BuildingInstance[] = [];
    const gardens = new FlatMesh(0.042);
    // Paving covers the driveway ribbon inside the parcel, leaving the kerb entrance visible.
    const yards = new FlatMesh(0.054);
    const gravel = new FlatMesh(0.055);
    const driveways = new FlatMesh(0.048);
    const hedges = new FlatMesh(0.08);
    const timber = new FlatMesh(0.35);
    const straps = new FlatMesh(0.37);
    const markings = new FlatMesh(0.07);
    const trees: Vec2[] = [];
    const sheds: Array<Vec2 & { angle: number }> = [];
    for (const [id, lot] of grown) {
      const blueprint = BLUEPRINTS.find(b => b.id === lot.design)!;
      instances.push({ ...lot, blueprint });
      const surface = blueprint.zone === 'workplaces' ? yards : gardens;
      surface.polygon(lot.corners);
      if (this.land) {
        const corners = extendYard(lot, blueprint, this.land, this.houses, { ground: gardens, paving: yards, gravel, hedge: hedges, marking: markings, trees, sheds, timber, straps });
        grown.set(id, { ...lot, corners });
      }
      driveways.ribbon(polyline([{ x: lot.streetX, y: lot.streetY }, lot]), 2.4);
    }
    this.grownLayer = buildBuildingLayer(instances);
    if (sheds.length) {
      const shape = houseGeometry([{ minX: -1.2, maxX: 1.2, depth: 2.3, wall: 1.6, roof: 0.55, ridge: 'x' }]);
      const material = new THREE.MeshLambertMaterial({ color: PALETTE.building.industrial.timber, vertexColors: true });
      const mesh = new THREE.InstancedMesh(shape, material, sheds.length);
      sheds.forEach((p, i) => mesh.setMatrixAt(i, new THREE.Matrix4().makeRotationY(p.angle).setPosition(p.x, 0, -p.y)));
      mesh.castShadow = true;
      this.grownLayer.add(mesh);
    }
    if (trees.length) {
      const crowns = new THREE.InstancedMesh(new THREE.IcosahedronGeometry(1.6, 1), flatMaterial(PALETTE.orchard[0]), trees.length);
      trees.forEach((p, i) => crowns.setMatrixAt(i, new THREE.Matrix4().makeTranslation(p.x, 1.7, -p.y)));
      crowns.castShadow = true;
      this.grownLayer.add(crowns);
    }
    const industrial = PALETTE.building.industrial;
    const surfaces = [
      [gravel, PALETTE.yardGravel], [hedges, PALETTE.building.hedge], [markings, industrial.marking], [timber, industrial.timber],
      [straps, industrial.strap], [gardens, PALETTE.gardens[0]], [yards, industrial.apron], [driveways, PALETTE.roadSurface],
    ] as const;
    for (const [mesh, colour] of surfaces) {
      if (mesh.empty) continue;
      const ground = new THREE.Mesh(mesh.build(), flatMaterial(colour));
      ground.receiveShadow = true;
      this.grownLayer.add(ground);
    }
    this.group.add(this.grownLayer);
    if (this.selected !== null) this.select(this.selected);
  }

  /** The house whose parcel (its garden, or the house itself) contains `p`. */
  houseAt(p: Vec2): number | null {
    for (const [i, house] of this.houses.entries()) {
      const g = house.garden;
      if (g) {
        if (p.x >= g.minX && p.x <= g.maxX && p.y >= g.minY && p.y <= g.maxY) return i;
        continue;
      }
      const q = local(house, p);
      if (LEVELS[this.levels[i]! - 1]!.some((b) => q.x >= b.minX && q.x <= b.maxX && Math.abs(q.y) <= b.depth / 2)) return i;
    }
    for (const [id, lot] of this.grown) {
      let inside = false;
      let prev = lot.corners.at(-1)!;
      for (const next of lot.corners) {
        if ((prev.y > p.y) !== (next.y > p.y)
          && p.x < prev.x + (next.x - prev.x) * (p.y - prev.y) / (next.y - prev.y)) inside = !inside;
        prev = next;
      }
      if (inside) return id;
    }
    return null;
  }

  select(index: number | null): void {
    this.selected = index;
    if (this.selection) {
      this.selection.geometry.dispose();
      this.selection.removeFromParent();
      this.selection = null;
    }
    if (index === null) return;
    const house = this.houses[index];
    const lot = this.grown.get(index);
    if (!house && !lot) return;
    const g = house?.garden;
    const corners = lot ? lot.corners : g
      ? [{ x: g.minX, y: g.minY }, { x: g.maxX, y: g.minY }, { x: g.maxX, y: g.maxY }, { x: g.minX, y: g.maxY }]
      : [{ x: -8, y: -6 }, { x: 6, y: -6 }, { x: 6, y: 6 }, { x: -8, y: 6 }].map((c) => {
        const cos = Math.cos(house!.angle);
        const sin = Math.sin(house!.angle);
        return { x: house!.x + c.x * cos - c.y * sin, y: house!.y + c.x * sin + c.y * cos };
      });
    const outline = new FlatMesh(0.3);
    outline.ribbon(polyline(corners, true), 0.35);
    this.selection = new THREE.Mesh(outline.build(), this.outlineMaterial);
    this.group.add(this.selection);
  }

  private readonly outlineMaterial = new THREE.MeshBasicMaterial({ color: PALETTE.selection });
}
