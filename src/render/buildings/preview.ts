import * as THREE from 'three';
import { CELL_WIDTH, CELL_DEPTH } from '../../sim/zoning/cells';
import { disposeLayer } from '../dispose';
import { AMBIENT_INTENSITY, SUN_DIRECTION, SUN_INTENSITY } from '../lighting';
import { PALETTE } from '../palette';
import { buildBuildingLayer, type BuildingInstance } from './mesh';
import type { Blueprint, Tier } from './types';
import { pickBuilding, variants } from './variation';

function ground(group: THREE.Group, x: number, y: number, width: number, depth: number, color: string, height = -0.02) {
  const mesh = new THREE.Mesh(new THREE.PlaneGeometry(width, depth), new THREE.MeshLambertMaterial({ color }));
  mesh.rotation.x = -Math.PI / 2;
  mesh.position.set(x, height, -y);
  mesh.receiveShadow = true;
  group.add(mesh);
}

/** One temporary WebGL context paints all the static preview canvases. */
export class PreviewRenderer {
  private readonly renderer = new THREE.WebGLRenderer({ antialias: true });

  constructor() {
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFShadowMap;
  }

  private paint(canvas: HTMLCanvasElement, lots: THREE.Group, width: number, depth: number) {
    const scene = new THREE.Scene();
    scene.background = new THREE.Color(PALETTE.ground);
    scene.add(lots, new THREE.AmbientLight(PALETTE.light, AMBIENT_INTENSITY));
    const sun = new THREE.DirectionalLight(PALETTE.light, SUN_INTENSITY);
    sun.position.copy(SUN_DIRECTION).multiplyScalar(width + depth);
    sun.castShadow = true;
    const shadowResolution = canvas.width / 2;
    sun.shadow.mapSize.set(shadowResolution, shadowResolution);
    sun.shadow.normalBias = 0.08;
    Object.assign(sun.shadow.camera, { left: -width / 2, right: width / 2, top: width / 2, bottom: -width / 2, far: 3 * (width + depth) });
    scene.add(sun);
    ground(lots, 0, 0, width * 2, depth * 2, PALETTE.ground, -0.08);
    const camera = new THREE.OrthographicCamera(-width / 2, width / 2, depth / 2, -depth / 2, 1, 500);
    camera.position.set(0, 180, 46);
    camera.lookAt(0, 0, 0);
    canvas.height = Math.round(canvas.width * depth / width);
    this.renderer.setSize(canvas.width, canvas.height, false);
    this.renderer.render(scene, camera);
    canvas.getContext('2d')!.drawImage(this.renderer.domElement, 0, 0);
    sun.shadow.dispose();
    disposeLayer(lots);
  }

  sheet(canvas: HTMLCanvasElement, blueprint: Blueprint) {
    const group = new THREE.Group();
    const width = blueprint.lot.columns * CELL_WIDTH;
    const depth = blueprint.lot.rows * CELL_DEPTH;
    const pitch = Math.max(width, depth * 0.88) + 2;
    const finishes = variants(blueprint);
    const instances = finishes.map((variant, i) => {
      const x = (i - (finishes.length - 1) / 2) * pitch;
      ground(group, x, 0, width, depth, PALETTE.gardens[0]);
      return { blueprint, variant, x, y: 0, angle: 0 };
    });
    group.add(buildBuildingLayer(instances));
    this.paint(canvas, group, pitch * finishes.length + 1, Math.max(depth + 4, pitch * 0.75));
  }

  street(canvas: HTMLCanvasElement) {
    const group = new THREE.Group();
    const instances: BuildingInstance[] = [];
    const tiers: Tier[] = ['cheap', 'cheap', 'mid', 'mid', 'expensive', 'mid', 'expensive', 'expensive'];
    const columns = [1, 2, 2, 2, 3, 2, 2, 2];
    const length = columns.reduce((a, b) => a + b) * CELL_WIDTH;
    ground(group, 0, 0, length + 18, 8.8, PALETTE.roadOutline);
    ground(group, 0, 0, length + 18, 8, PALETTE.roadSurface, -0.01);
    for (const side of [-1, 1]) {
      let edge = -length / 2;
      let previous: string[] = [];
      for (let i = 0; i < columns.length; i++) {
        const j = side === 1 ? i : columns.length - 1 - i;
        const lot = { columns: columns[j], rows: columns[j] === 3 ? 4 : columns[j] };
        const pick = pickBuilding(`garden-road/${side}/${i}`, tiers[j], lot, previous);
        previous = [pick.blueprint.id];
        const width = lot.columns * CELL_WIDTH;
        const depth = lot.rows * CELL_DEPTH;
        const x = edge + width / 2;
        const y = side * (4.5 + depth / 2);
        ground(group, x, y, width - 0.25, depth, PALETTE.gardens[(i + side + 1) % 3]);
        const entry = pick.blueprint.parts.find(p => p.kind === 'garage')
          ?? pick.blueprint.parts.find(p => p.kind === 'porch')
          ?? pick.blueprint.parts.find(p => p.kind === 'block');
        if (entry && 'depth' in entry) {
          const front = entry.y - entry.depth / 2;
          const pathLength = depth / 2 + front + 0.5;
          const entryX = x + side * entry.x * (pick.variant.mirrored ? -1 : 1);
          ground(group, entryX, side * (4 + pathLength / 2), entry.kind === 'garage' ? entry.width : 1,
            pathLength, PALETTE.building.trim, -0.005);
        }
        instances.push({ ...pick, x, y, angle: side === 1 ? 0 : Math.PI });
        edge += width;
      }
    }
    group.add(buildBuildingLayer(instances));
    this.paint(canvas, group, length + 18, 83);
  }

  dispose() {
    this.renderer.dispose();
    this.renderer.forceContextLoss();
  }
}
