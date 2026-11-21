import * as THREE from 'three';
import { polyline, sampleAt, type PathSample, type Polyline } from '../sim/math/polyline';
import type { Network } from '../sim/network/types';
import { FlatMesh, flatMaterial } from './flat';
import { PALETTE } from './palette';

const OUTLINE = 0.45;
/** Distance from a priority lane's centre at which the give-way line is drawn (half the ring width + a little). */
const GIVE_WAY_CLEARANCE = 4.9;
const LAYER = { outline: 0.05, surface: 0.1, marking: 0.15 } as const;

/**
 * Roads are drawn as layered ribbons: every surface's widened outline first, then every
 * surface on top. Overlapping junction pieces merge into one clean shape with a single outline.
 */
export function buildRoads(network: Network, marking: 'dashed' | 'solid' = 'solid'): THREE.Group {
  const outline = new FlatMesh(LAYER.outline);
  const surface = new FlatMesh(LAYER.surface);
  const centerLines = new FlatMesh(LAYER.marking);
  const giveWay = new FlatMesh(LAYER.marking);

  const pavement = new FlatMesh(0.13);
  const parking = new FlatMesh(0.12);
  const bayMarks = new FlatMesh(0.15);
  for (const s of network.surfaces) {
    outline.ribbon(s.centerline, s.width + OUTLINE * 2);
    if (s.style === 'footpath' || s.style === 'pavement' || s.style === 'parking') {
      const strip = s.style === 'parking' ? parking : pavement;
      strip.ribbon(s.centerline, s.width - 0.14);
      if (s.style === 'parking') {
        for (let at = 3; at < s.centerline.length - 1; at += 6) {
          const p = sampleAt(s.centerline, at, sample);
          const dx = -p.hy * s.width * 0.4, dy = p.hx * s.width * 0.4;
          bayMarks.ribbon(polyline([{ x: p.x - dx, y: p.y - dy }, { x: p.x + dx, y: p.y + dy }]), 0.12);
        }
      }
      continue;
    }
    surface.ribbon(s.centerline, s.width);
    if (s.style === 'twoWay') {
      if (s.roadType === 'country') continue;
      if (marking === 'dashed') centerLines.dashes(s.centerline, 0.22, 3, 6);
      else centerLines.ribbon(s.centerline, 0.3);
    }
  }

  // Give-way line: short dashes across the lane where it reaches the edge of the priority road.
  for (const lane of network.lanes) {
    if (lane.yieldTo.length === 0 && lane.crossingYieldTo.length === 0) continue;
    if (lane.crossingYieldTo.length > 0) {
      const movements = network.lanes[lane.prev[0]!]!.next;
      // Paint one line across the side approach. A left turn yielding to oncoming
      // cars on the main street shares its lane with a through movement.
      if (movements[0] !== lane.id || movements.some((id) => !network.lanes[id]!.crossingYieldTo.length)) continue;
    }
    const priority = [...lane.yieldTo, ...lane.next].map((id) => network.lanes[id]!.path);
    let s = lane.crossingYieldTo.length > 0 ? 0 : lane.length;
    while (s > 0 && distanceToPaths(sampleAt(lane.path, s, sample), priority) < GIVE_WAY_CLEARANCE) s -= 0.25;
    const e = sampleAt(lane.path, s, { x: 0, y: 0, hx: 0, hy: 0 });
    const back = { x: e.x - e.hx * 0.4, y: e.y - e.hy * 0.4 };
    const across = { x: -e.hy, y: e.hx };
    const half = 1.9;
    const line = {
      a: { x: back.x - across.x * half, y: back.y - across.y * half },
      b: { x: back.x + across.x * half, y: back.y + across.y * half },
    };
    for (let k = 0; k < 6; k++) {
      const t0 = k / 6 + 0.02;
      const t1 = t0 + 0.09;
      const p0 = { x: line.a.x + (line.b.x - line.a.x) * t0, y: line.a.y + (line.b.y - line.a.y) * t0 };
      const p1 = { x: line.a.x + (line.b.x - line.a.x) * t1, y: line.a.y + (line.b.y - line.a.y) * t1 };
      const w = { x: e.hx * 0.2, y: e.hy * 0.2 };
      giveWay.quad(
        { x: p0.x - w.x, y: p0.y - w.y },
        { x: p1.x - w.x, y: p1.y - w.y },
        { x: p1.x + w.x, y: p1.y + w.y },
        { x: p0.x + w.x, y: p0.y + w.y },
      );
    }
  }

  const stripes = new FlatMesh(0.16);
  for (const link of network.pedestrianLinks ?? []) {
    if (!link.zebra) continue;
    const path = polyline([link.a, link.b]);
    stripes.dashes(path, 3.2, 0.6, 0.55);
  }
  const group = new THREE.Group();
  group.name = 'roads';
  const add = (mesh: FlatMesh, color: string): void => {
    if (mesh.empty) return;
    const m = new THREE.Mesh(mesh.build(), flatMaterial(color));
    m.receiveShadow = true;
    group.add(m);
  };
  add(outline, PALETTE.roadOutline);
  add(surface, PALETTE.roadSurface);
  add(pavement, PALETTE.pavement);
  add(parking, PALETTE.parking);
  add(bayMarks, PALETTE.roadSurface);
  add(centerLines, PALETTE.centerLine);
  add(stripes, PALETTE.crossing);
  add(giveWay, PALETTE.giveWay);
  return group;
}

const sample: PathSample = { x: 0, y: 0, hx: 0, hy: 0 };

function distanceToPaths(p: { x: number; y: number }, paths: readonly Polyline[]): number {
  let best = Infinity;
  for (const path of paths) {
    const { pts } = path;
    for (let i = 0; i + 3 < pts.length; i += 2) {
      const ax = pts[i]!;
      const ay = pts[i + 1]!;
      const dx = pts[i + 2]! - ax;
      const dy = pts[i + 3]! - ay;
      const len2 = dx * dx + dy * dy;
      const t = len2 > 0 ? Math.min(1, Math.max(0, ((p.x - ax) * dx + (p.y - ay) * dy) / len2)) : 0;
      best = Math.min(best, Math.hypot(ax + dx * t - p.x, ay + dy * t - p.y));
    }
  }
  return best;
}
