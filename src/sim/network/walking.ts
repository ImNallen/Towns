import { signalAspect } from './signals';
import { crossingAt, observeCrossings, type Crossing } from '../traffic/pedestrianConflicts';
import type { Vehicles } from '../traffic/vehicles';
import { WalkRouting } from './walkRouting';
import type { Vec2 } from '../math/vec';
import type { Network } from './types';
import type { Bay } from '../town/parking';

export const WALK_TRIP_LIMIT = 600;
/** Maximum displacement in metres when an edit moves a walking surface. */
export const WALK_EDIT_SNAP_METRES = 3.5;
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
  readonly routing: WalkRouting;
  get next() { return this.routing.next; }
  get costs() { return this.routing.costs; }
  readonly crossings: Crossing[] = [];
  readonly stops: { crossing: Crossing; from: number; to: number }[][];
  edgeCount = 0;

  constructor(network: Network, doors: readonly Vec2[], bays: readonly Bay[], previous?: WalkRouting, parks: readonly Vec2[] = []) {
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
      crossing.signal = link.signal;
      crossing.walkGroup = link.walkGroup;
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
    this.routing = new WalkRouting(this.points,this.edges,this.places,previous);
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
  /** First hop from a mid-edge snap, until the walker reaches a routing node. */
  readonly firstHop: Int32Array;
  cleared = 0;
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
    this.firstHop = new Int32Array(capacity).fill(-1);
    this.crowd = new Uint16Array(graph.edgeCount);
  }
  start(p: number, from: number, to: number, age: number): boolean {
    if (!Number.isFinite(this.graph.distance(from, to))) return false;
    this.node[p] = this.graph.places[from]!;
    this.goal[p] = to;
    this.firstHop[p] = -1;
    this.along[p] = 0;
    this.speed[p] = (1.2 + ((p * 17) % 31) / 100) * (age < 12 || age > 65 ? 0.85 : 1);
    this.peak = Math.max(this.peak, ++this.count);
    return true;
  }
  private edge(p: number): Edge | undefined {
    const n = this.node[p]!;
    const to = this.firstHop[p]! >= 0 ? this.firstHop[p] : this.graph.next[this.goal[p]!]![n];
    for (const edge of this.graph.edges[n]!) if (edge.to === to) return edge;
    return undefined;
  }
  /** Project the current position onto the nearest reachable segment during an edit. */
  restore(p: number, old: Walkers, dest: number): boolean {
    const graph = this.graph;
    const costs = graph.costs[dest];
    if (!costs) return false;
    const edge = old.edge(p);
    const from = old.graph.points[old.node[p]!]!;
    const to = edge ? old.graph.points[edge.to]! : from;
    const fraction = edge ? old.along[p]! / edge.length : 0;
    const x = from.x + fraction * (to.x - from.x);
    const y = from.y + fraction * (to.y - from.y);
    let distance = WALK_EDIT_SNAP_METRES ** 2;
    let remaining = Infinity;
    let node = -1, hop = -1, along = 0;
    const consider = (d: number, cost: number, start: number, end: number, s: number) => {
      if (d > distance || (d === distance && cost >= remaining)) return;
      distance = d;
      remaining = cost;
      node = start;
      hop = end;
      along = s;
    };
    for (let a = 0; a < graph.points.length; a++) {
      if (!Number.isFinite(costs[a])) continue;
      const point = graph.points[a]!;
      const dx = x - point.x, dy = y - point.y;
      consider(dx * dx + dy * dy, costs[a]!, a, -1, 0);
      for (const segment of graph.edges[a]!) {
        const b = segment.to;
        if (b <= a) continue;
        const end = graph.points[b]!;
        const vx = end.x - point.x, vy = end.y - point.y;
        const t = (dx * vx + dy * vy) / (vx * vx + vy * vy);
        if (t <= 0 || t >= 1) continue;
        const d = (dx - t * vx) ** 2 + (dy - t * vy) ** 2;
        // A new crossing must be entered from the kerb after observing traffic.
        if (segment.crossing && !(edge?.crossing && d < 1e-12)) continue;
        const s = t * segment.length;
        const back = s + costs[a]!, forward = segment.length - s + costs[b]!;
        if (back < forward) consider(d, back, b, a, segment.length - s);
        else consider(d, forward, a, b, s);
      }
    }
    if (node < 0) return false;
    this.node[p] = node;
    this.firstHop[p] = hop === graph.next[dest]![node] ? -1 : hop;
    this.along[p] = along;
    this.goal[p] = dest;
    this.speed[p] = old.speed[p]!;
    this.peak = Math.max(this.peak, ++this.count);
    return true;
  }
  step(dt: number, vehicles?: Vehicles, tick = 0): void {
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
        if (!this.along[i]) c.waiting = true;
        const permitted = c.walkGroup === undefined || signalAspect(c.walkGroup, c.clock ?? tick) === 'green';
        c.requested ||= permitted;
        if (!this.along[i] && (c.blocked || !permitted)) continue;
        c.occupied=true;
      }
      this.along[i] += (this.speed[i]! * dt) / (1 + 0.15 * Math.max(0, (edge ? this.crowd[edge.id]! : 0) - 1));
      while (edge && this.along[i]! >= edge.length) {
        this.along[i] -= edge.length;
        if (edge.crossing) edge.crossing.served++;
        this.node[i] = edge.to;
        this.firstHop[i] = -1;
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
