import { sampleAt } from '../math/polyline';
import type { Vec2 } from '../math/vec';
import type { Network } from '../network/types';
import type { Vehicles } from './vehicles';

export interface Crossing {
  signal?: number;
  clock?: number;
  waiting?: boolean;
  walkGroup?: number;
  zebra: boolean;
  /** Interval of vehicle-front positions where the nose intersects the crossing.
   * Include the vehicle length when checking whether its tail has left. */
  lanes: { lane: number; from: number; to: number }[];
  occupied: boolean;
  requested: boolean;
  blocked: boolean;
  served: number;
  yieldingTicks: number;
}

export function crossingAt(network: Network, a: Vec2, b: Vec2, zebra: boolean): Crossing {
  const lanes: Crossing['lanes'] = [];
  const dx = b.x - a.x,
    dy = b.y - a.y,
    length2 = dx * dx + dy * dy;
  const p = { x: 0, y: 0, hx: 0, hy: 0 };
  for (const lane of network.lanes) {
    let from = Infinity,
      to = -Infinity;
    const samples = Math.ceil(lane.length / 0.5);
    for (let i = 0; i <= samples; i++) {
      const s = (lane.length * i) / samples;
      sampleAt(lane.path, s, p);
      const t = Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / length2));
      if ((p.x - a.x - t * dx) ** 2 + (p.y - a.y - t * dy) ** 2 > 2.6 ** 2) continue;
      from = Math.min(from, s - 0.5);
      to = Math.max(to, s + 0.5);
    }
    if (from !== Infinity) lanes.push({ lane: lane.id, from, to });
  }
  return { zebra, lanes, occupied: false, requested: false, blocked: false, served: 0, yieldingTicks: 0 };
}

export interface CrossingStop {
  crossing: Crossing;
  from: number;
  to: number;
}

export function observeCrossings(crossings: Crossing[], stops: CrossingStop[][], vehicles: Vehicles): void {
  for (const c of crossings) {
    c.waiting = false;
    c.requested = c.occupied = c.blocked = false;
  }
  for (let p = 0; p < vehicles.highWater; p++) {
    if (!vehicles.alive[p]) continue;
    for (const zone of stops[vehicles.lane[p]!]!) {
      const c = zone.crossing;
      if (c.blocked) continue;
      const front = vehicles.s[p]!;
      if (front - vehicles.length[p]! > zone.to) continue;
      const speed = vehicles.v[p]!;
      const gap = c.zebra || c.walkGroup !== undefined
        ? (speed * speed) / (2 * vehicles.brake[p]!) + speed * 0.1 : Math.max(1, speed) * 7;
      if (front + gap > zone.from + 0.00001) c.blocked = true;
    }
  }
}
