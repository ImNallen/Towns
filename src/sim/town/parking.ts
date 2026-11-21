import { sampleAt } from '../math/polyline';
import type { Vec2 } from '../math/vec';
import { accessPoints } from '../scenarios/meadow';
import type { HomeSpec, Scenario } from '../scenarios/types';
import type { AccessPoint, Routing } from '../traffic/routing';
import { findCell, type CellKey } from '../zoning/cells';
import type { Zoning } from '../zoning/paint';

export const WALK_LIMIT = 250;
export const walkMinutes = (metres: number) => Math.max(1, Math.ceil(metres / 1.4));
export type BayKind = 'driveway' | 'yard' | 'street' | 'lot';
export interface Bay extends Vec2 {
  key: string;
  kind: BayKind;
  home: number;
  angle: number;
  access: AccessPoint[];
}

export function parkingBays(scenario: Scenario, homes: HomeSpec[], zoning: Zoning): Bay[] {
  const bays: Bay[] = [];
  const cells = scenario.zones;
  function cellBays(key: CellKey, home: number, count: number, access: AccessPoint[]) {
    if (!cells) return;
    const i = findCell(cells, key);
    if (i < 0) return;
    const q = cells.corners.subarray(i * 8, i * 8 + 8);
    const dx = q[2]! - q[0]!,
      dy = q[3]! - q[1]!;
    for (let j = 0; j < count; j++) {
      const t = home < 0 ? 0.28 + 0.44 * j : 0.27 + 0.3 * j;
      const u = 0.42;
      bays.push({
        key: 'cell/' + key + '/' + j,
        home,
        kind: home < 0 ? 'lot' : 'yard',
        access,
        angle: Math.atan2(dx, -dy),
        x: (1 - u) * (q[0]! + t * dx) + u * (q[6]! + t * (q[4]! - q[6]!)),
        y: (1 - u) * (q[1]! + t * dy) + u * (q[7]! + t * (q[5]! - q[7]!)),
      });
    }
  }
  homes.forEach(({ lot, access }, home) => {
    const house = lot ?? scenario.decor.houses[home];
    if (!house) return;
    const zone = lot?.designs[0]!.blueprint.zone;
    if (lot && zone !== 'residential') {
      for (let c = 0; c < lot.columns; c++) {
        const key = (lot.key + c * 8 + lot.rows) as CellKey;
        if (cells && !cells.gardenCells?.[findCell(cells, key)] && zoning.get(key) === zone)
          cellBays(key, home, zone === 'shops' ? 1 : 2, access);
      }
      return;
    }
    const side = house.y < (house.x < 0 ? -8 : 8) ? 1 : -1;
    const angle = lot ? lot.angle : 0;
    for (let j = 0; j < (lot?.columns ?? 1); j++)
      bays.push({
        key: 'home/' + home + '/' + j,
        home,
        kind: 'driveway',
        access,
        angle,
        x: lot ? lot.streetX + (lot.x - lot.streetX) * 0.62 + Math.cos(angle) * (j - 0.5) * 4.8 : house.x - 4,
        y: lot ? lot.streetY + (lot.y - lot.streetY) * 0.62 + Math.sin(angle) * (j - 0.5) * 4.8 : house.y + side * 7,
      });
  });
  for (const surface of scenario.network.surfaces) {
    if (surface.style !== 'parking') continue;
    for (let at = 6; at + 3 <= surface.centerline.length; at += 6) {
      const p = sampleAt(surface.centerline, at, { x: 0, y: 0, hx: 0, hy: 0 });
      const offset = 4.6;
      let access = accessPoints(scenario.network, { x: p.x - p.hy * offset, y: p.y + p.hx * offset });
      if (!access.length) access = accessPoints(scenario.network, { x: p.x + p.hy * offset, y: p.y - p.hx * offset });
      if (!access.length) continue;
      // Park parallel to the lane on this side of the centreline.
      let nearest = Infinity,
        angle = 0;
      for (const a of access) {
        const lane = sampleAt(scenario.network.lanes[a.lane]!.path, a.s, { x: 0, y: 0, hx: 0, hy: 0 });
        const dx = p.x - lane.x,
          dy = p.y - lane.y;
        if (dx * dx + dy * dy >= nearest) continue;
        nearest = dx * dx + dy * dy;
        angle = Math.atan2(lane.hy, lane.hx);
      }
      bays.push({
        key: 'street/' + p.x.toFixed(2) + '/' + p.y.toFixed(2),
        x: p.x,
        y: p.y,
        angle,
        kind: 'street',
        home: -1,
        access,
      });
    }
  }
  if (cells)
    for (const [key, use] of zoning) {
      if (use !== 'parking') continue;
      const i = findCell(cells, key);
      if (i < 0) continue;
      const q = cells.corners.subarray(i * 8, i * 8 + 8);
      const dx = q[2]! - q[0]!,
        dy = q[3]! - q[1]!;
      const k = (cells.kerbs?.[i] ?? 5.5) / Math.hypot(dx, dy);
      cellBays(
        key,
        -1,
        2,
        accessPoints(scenario.network, { x: (q[0]! + q[2]!) / 2 + dy * k, y: (q[1]! + q[3]!) / 2 - dx * k }),
      );
    }
  return bays;
}

export function sameEntrance(a: readonly AccessPoint[], b: readonly AccessPoint[]): boolean {
  for (const left of a)
    for (const right of b) {
      if (left.lane === right.lane && Math.abs(left.s - right.s) < 0.01) return true;
    }
  return false;
}

export class Parking {
  readonly occupant: Int32Array;
  constructor(
    readonly bays: Bay[],
    readonly firstDest: number,
  ) {
    this.occupant = new Int32Array(bays.length).fill(-1);
  }

  nearest(
    home: number,
    door: Vec2,
    residential: boolean,
    open: Uint8Array,
    access: AccessPoint[],
    routing: Routing,
  ): number {
    let best = -1,
      distance = Infinity,
      own = false;
    for (let i = 0; i < this.bays.length; i++) {
      const b = this.bays[i]!;
      if (this.occupant[i]! >= 0 || (b.kind === 'driveway' && b.home !== home)) continue;
      if (residential && b.home !== home && b.kind !== 'street') continue;
      if (b.kind === 'yard' && !open[b.home]) continue;
      const dx = b.x - door.x,
        dy = b.y - door.y;
      const d = dx * dx + dy * dy;
      const preferred = b.home === home;
      if (d > WALK_LIMIT * WALK_LIMIT || (!preferred && own) || (preferred === own && d >= distance)) continue;
      if (!sameEntrance(access, b.access) && routing.bestAccess(access, this.firstDest + i) < 0) continue;
      best = i;
      distance = d;
      own = preferred;
    }
    return best;
  }
}
