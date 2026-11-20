import * as THREE from 'three';
import { endOf, sampleAt, type PathSample } from '../sim/math/polyline';
import type { Network } from '../sim/network/types';
import { PALETTE } from './palette';

const HEIGHT = 3;

/** Lane graph overlay: lane centrelines by kind, direction chevrons, give-way points in red. */
export function buildLaneOverlay(network: Network): THREE.Group {
  const positions: number[] = [];
  const colors: number[] = [];
  const c = new THREE.Color();
  const push = (x: number, y: number): void => {
    positions.push(x, HEIGHT, -y);
    colors.push(c.r, c.g, c.b);
  };
  const s: PathSample = { x: 0, y: 0, hx: 0, hy: 0 };

  for (const lane of network.lanes) {
    c.set(PALETTE.debugLane[lane.kind]);
    const { pts } = lane.path;
    for (let i = 0; i + 3 < pts.length; i += 2) {
      push(pts[i]!, pts[i + 1]!);
      push(pts[i + 2]!, pts[i + 3]!);
    }
    // Chevrons pointing in the direction of travel.
    for (let d = 6; d < lane.length - 2; d += 12) {
      sampleAt(lane.path, d, s);
      const bx = s.x - s.hx * 1.4;
      const by = s.y - s.hy * 1.4;
      push(s.x, s.y);
      push(bx - s.hy * 0.9, by + s.hx * 0.9);
      push(s.x, s.y);
      push(bx + s.hy * 0.9, by - s.hx * 0.9);
    }
  }

  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  g.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
  const group = new THREE.Group();
  group.name = 'lane-overlay';
  group.add(new THREE.LineSegments(g, new THREE.LineBasicMaterial({ vertexColors: true, depthTest: false })));

  const yieldPoints = network.lanes.filter((l) => l.yieldTo.length > 0).map((l) => endOf(l.path));
  const dot = new THREE.CircleGeometry(0.9, 16).rotateX(-Math.PI / 2);
  const dots = new THREE.InstancedMesh(dot, new THREE.MeshBasicMaterial({ color: PALETTE.debugYield, depthTest: false }), Math.max(yieldPoints.length, 1));
  yieldPoints.forEach((p, i) => dots.setMatrixAt(i, new THREE.Matrix4().makeTranslation(p.x, HEIGHT + 0.1, -p.y)));
  dots.count = yieldPoints.length;
  group.add(dots);
  group.renderOrder = 10;
  return group;
}
