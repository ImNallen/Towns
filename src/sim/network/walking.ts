import { crossingAt, observeCrossings, type Crossing } from '../traffic/pedestrianConflicts';
import type { Vehicles } from '../traffic/vehicles';
import type { Vec2 } from '../math/vec';
import type { Network } from './types';
import type { Bay } from '../town/parking';

export const WALK_TRIP_LIMIT = 600;
interface Edge {
  to: number;
  length: number;
  id: number;
  crossing?: Crossing;
}

/** Frontages are split into the pavement polyline at their perpendicular projection.
 * Only geometry changes rebuild the destination tables. */
export class WalkingNetwork {
  readonly points: Vec2[] = [];
  readonly edges: Edge[][] = [];
  readonly places: number[] = [];
  readonly next: Int32Array[] = [];
  readonly costs: Float64Array[] = [];
  readonly crossings: Crossing[] = [];
  readonly stops: { crossing: Crossing; from: number; to: number }[][];
  edgeCount = 0;

  constructor(network: Network, doors: readonly Vec2[], bays: readonly Bay[], parks: readonly Vec2[] = []) {
    this.stops = network.lanes.map(() => []);
    const ids = new Map<string, number>();
    const node = (p: Vec2) => {
      const key = Math.round(p.x * 10000) + '/' + Math.round(p.y * 10000);
      const found = ids.get(key);
      if (found !== undefined) return found;
      const id = this.points.push(p) - 1;
      this.edges.push([]);
      ids.set(key, id);
      return id;
    };
    const join = (a: number, b: number, crossing?: Crossing) => {
      if (a === b) return;
      const p = this.points[a]!,
        q = this.points[b]!;
      const length = Math.hypot(p.x - q.x, p.y - q.y);
      const id = this.edgeCount++;
      this.edges[a]!.push({ to: b, length, id, crossing });
      this.edges[b]!.push({ to: a, length, id, crossing });
    };
    const strips = network.surfaces
      .filter((s) => s.style === 'pavement' || s.style === 'footpath')
      .flatMap((s) => {
        const segments = [];
        const pts = s.centerline.pts;
        for (let i = 2; i < pts.length; i += 2) {
          const a = { x: pts[i - 2]!, y: pts[i - 1]! },
            b = { x: pts[i]!, y: pts[i + 1]! };
          segments.push({
            a,
            b,
            surface: s,
            cuts: [
              { t: 0, id: node(a) },
              { t: 1, id: node(b) },
            ],
          });
        }
        return segments;
      });
    const attach = (point: Vec2, reach: number, skip = -1) => {
      const place = node(point);

      let best = reach * reach,
        at = 0;
      let strip: (typeof strips)[number] | undefined;
      for (const s of strips) {
        if (s.surface.id === skip) continue;
        const dx = s.b.x - s.a.x,
          dy = s.b.y - s.a.y;
        const t = Math.max(0, Math.min(1, ((point.x - s.a.x) * dx + (point.y - s.a.y) * dy) / (dx * dx + dy * dy)));
        const d = (point.x - s.a.x - t * dx) ** 2 + (point.y - s.a.y - t * dy) ** 2;
        if (d < best) {
          best = d;
          at = t;
          strip = s;
        }
      }
      if (!strip) return place;
      const id = node({ x: strip.a.x + at * (strip.b.x - strip.a.x), y: strip.a.y + at * (strip.b.y - strip.a.y) });
      strip.cuts.push({ t: at, id });
      join(place, id);
      return place;
    };
    for (const point of [...doors, ...bays,...parks]) this.places.push(attach(point,30));
    for (const s of strips) if (s.surface.style === 'footpath') {
      attach(s.a,0.05,s.surface.id);
      attach(s.b,0.05,s.surface.id);
    }
    for (const link of network.pedestrianLinks ?? []) {
      const a = attach(link.a,0.05), b = attach(link.b,0.05);
      if (!link.crossing) { join(a,b); continue; }
      const crossing = crossingAt(network,link.a,link.b,!!link.zebra);
      this.crossings.push(crossing);
      for (const zone of crossing.lanes) this.stops[zone.lane]!.push({crossing,from:zone.from,to:zone.to});
      join(a,b,crossing);
    }
    for (const strip of strips) {
      strip.cuts.sort((a, b) => a.t - b.t);
      for (let i = 1; i < strip.cuts.length; i++) join(strip.cuts[i - 1]!.id, strip.cuts[i]!.id);
    }

    bays.forEach((b, i) => {
      if (b.home >= 0) join(this.places[b.home]!, this.places[doors.length + i]!);
    });
    for (const target of this.places) {
      const cost = new Float64Array(this.points.length).fill(Infinity);
      const next = new Int32Array(this.points.length).fill(-1);
      const seen = new Uint8Array(this.points.length);
      cost[target] = 0;
      for (;;) {
        let n = -1,
          min = Infinity;
        for (let i = 0; i < cost.length; i++)
          if (!seen[i] && cost[i]! < min) {
            min = cost[i]!;
            n = i;
          }
        if (n < 0) break;
        seen[n] = 1;
        for (const edge of this.edges[n]!) {
          if (min + edge.length >= cost[edge.to]!) continue;
          cost[edge.to] = min + edge.length;
          next[edge.to] = n;
        }
      }
      this.costs.push(cost);
      this.next.push(next);
    }
  }

  distance(from: number, to: number): number {
    return this.costs[to]?.[this.places[from]!] ?? Infinity;
  }
}

export class Walkers {
  readonly goal: Int32Array;
  readonly node: Int32Array;
  readonly along: Float64Array;
  readonly speed: Float64Array;
  readonly crowd: Uint16Array;
  count = 0;
  peak = 0;
  constructor(
    readonly graph: WalkingNetwork,
    capacity: number,
  ) {
    this.goal = new Int32Array(capacity).fill(-1);
    this.node = new Int32Array(capacity);
    this.along = new Float64Array(capacity);
    this.speed = new Float64Array(capacity);
    this.crowd = new Uint16Array(graph.edgeCount);
  }
  start(p: number, from: number, to: number, age: number): boolean {
    if (!Number.isFinite(this.graph.distance(from, to))) return false;
    this.node[p] = this.graph.places[from]!;
    this.goal[p] = to;
    this.along[p] = 0;
    this.speed[p] = (1.2 + ((p * 17) % 31) / 100) * (age < 12 || age > 65 ? 0.85 : 1);
    this.peak = Math.max(this.peak, ++this.count);
    return true;
  }
  private edge(p: number): Edge | undefined {
    const n = this.node[p]!;
    const to = this.graph.next[this.goal[p]!]![n];
    for (const edge of this.graph.edges[n]!) if (edge.to === to) return edge;
    return undefined;
  }
  step(dt: number, vehicles?: Vehicles): void {
    if (vehicles) observeCrossings(this.graph.crossings,vehicles);
    if (!this.count) return;
    this.crowd.fill(0);
    for (let i = 0; i < this.goal.length; i++) {
      if (this.goal[i]! < 0) continue;
      const edge = this.edge(i);
      if (edge) this.crowd[edge.id]++;
    }
    for (let i = 0; i < this.goal.length; i++) {
      if (this.goal[i]! < 0) continue;
      let edge = this.edge(i);
      if (edge?.crossing) {
        const c=edge.crossing;
        c.requested=true;
        if (!this.along[i] && c.blocked) continue;
        c.occupied=true;
      }
      this.along[i] += (this.speed[i]! * dt) / (1 + 0.15 * Math.max(0, (edge ? this.crowd[edge.id]! : 0) - 1));
      while (edge && this.along[i]! >= edge.length) {
        this.along[i] -= edge.length;
        if (edge.crossing) edge.crossing.served++;
        this.node[i] = edge.to;
        edge = this.edge(i);
        if (edge?.crossing) { this.along[i]=0; break; }
      }
      if (!edge) {
        this.goal[i] = -1;
        this.count--;
      }
    }
  }
  positions(): Float32Array {
    const out = new Float32Array(this.count * 3);
    let slot = 0;
    for (let i = 0; i < this.goal.length; i++) {
      if (this.goal[i]! < 0) continue;
      const edge = this.edge(i);
      const a = this.graph.points[this.node[i]!]!;
      const b = edge ? this.graph.points[edge.to]! : a;
      const t = edge ? this.along[i]! / edge.length : 0;
      out[slot++] = a.x + (b.x - a.x) * t;
      out[slot++] = a.y + (b.y - a.y) * t;
      out[slot++] = i;
    }
    return out;
  }
}
