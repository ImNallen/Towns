import type { Network } from '../network/types';

/** Where a building meets the street: a point on one directional lane. */
export interface AccessPoint {
  lane: number;
  /** Arc length along the lane, m. */
  s: number;
}

/**
 * Next-hop tables: for every destination and every lane, the lane to take next on the
 * fastest free-flow route. Built with a reverse Dijkstra per destination.
 *
 * Destinations `[0, sinks.length)` are the network's sinks (leave at the lane end).
 * Further destinations are buildings, each reached at any of its access points.
 * Vehicles store only their destination index, so routes cost no per-vehicle memory.
 * Each refresh publishes one complete destination tree so drivers see a coherent route.
 */
export class Routing {
  readonly sinks: readonly number[];
  /** Number of destinations: sinks, then building targets. */
  readonly destinations: number;
  private readonly nextHops: Int32Array[] = [];
  private readonly costs: Float64Array[] = [];
  /** Per destination and lane: the `s` at which a vehicle arrives (Infinity = keep driving). */
  private readonly exits: Float64Array[] = [];
  private readonly seeds: readonly (readonly AccessPoint[])[];
  private readonly oldNext: Int32Array;
  private readonly inverseSpeed: Float64Array[] = [];
  private readonly heap: MinHeap;
  private cursor = 0;
  private sweepAt = 0;

  constructor(private readonly network: Network, targets: readonly (readonly AccessPoint[])[] = []) {
    this.sinks = network.sinks;
    this.seeds = [...this.sinks.map(lane => [{ lane, s: network.lanes[lane]!.length }]), ...targets];
    this.destinations = this.seeds.length;
    const n = network.lanes.length;
    this.oldNext = new Int32Array(n);
    this.heap = new MinHeap(network.lanes.reduce((total, lane) => total + lane.prev.length, n + 1));
    const free = Float64Array.from(network.lanes, l => l.length / l.speedLimit);
    for (let d = 0; d < this.destinations; d++) {
      this.nextHops.push(new Int32Array(n).fill(-1));
      this.costs.push(new Float64Array(n));
      this.exits.push(new Float64Array(n).fill(Infinity));
      this.inverseSpeed.push(new Float64Array(n));
      this.rebuild(d, free);
    }
  }

  refresh(tick: number, seconds: Float64Array): void {
    if (!this.destinations || tick < this.sweepAt) return;
    this.rebuild(this.cursor++, seconds);
    if (this.cursor === this.destinations) {
      this.cursor = 0;
      this.sweepAt = tick + 200;
    }
  }

  private rebuild(d: number, seconds: Float64Array): void {
    const cost = this.costs[d]!, next = this.nextHops[d]!, exit = this.exits[d]!;
    const pace = this.inverseSpeed[d]!;
    this.oldNext.set(next);
    cost.fill(Infinity);
    next.fill(-1);
    for (const lane of this.network.lanes) pace[lane.id] = seconds[lane.id]! / lane.length;
    for (const { lane, s } of this.seeds[d]!) {
      if (s >= exit[lane]! && cost[lane]! < Infinity) continue;
      exit[lane] = s;
      cost[lane] = s * pace[lane]!;
      this.heap.push(lane, cost[lane]!);
    }
    while (this.heap.size) {
      const key = this.heap.firstKey;
      const lane = this.heap.popId();
      if (key !== cost[lane]) continue;
      for (const p of this.network.lanes[lane]!.prev) {
        // A turn change must save three game minutes to displace the established route.
        const switchCost = this.oldNext[p]! >= 0 && this.oldNext[p] !== lane ? 3 : 0;
        const candidate = key + seconds[p]! + switchCost;
        if (candidate < cost[p]!) {
          next[p] = lane;
          cost[p] = candidate;
          this.heap.push(p, candidate);
        } else if (candidate === cost[p] && lane < next[p]!) next[p] = lane;
      }
    }
  }

  /** Next lane towards `dest`, or -1 on the destination's own lane or when unreachable. */
  nextHop(dest: number, lane: number): number {
    return this.nextHops[dest]![lane]!;
  }

  /** A vehicle for `dest` on `lane` has arrived once its `s` reaches this (Infinity elsewhere). */
  exit(dest: number, lane: number): number {
    return this.exits[dest]![lane]!;
  }

  canReach(dest: number, lane: number): boolean {
    return this.costs[dest]![lane]! < Infinity;
  }

  /** Free-flow travel time from the start of `lane` to the destination, s. */
  travelTime(dest: number, lane: number): number {
    return this.costs[dest]![lane]!;
  }

  /** Free-flow time from `s` on `lane` to `dest`, s. Infinity if unreachable or the exit is behind. */
  timeFrom(dest: number, lane: number, s: number): number {
    if (this.exits[dest]![lane]! <= s) return Infinity;
    return this.costs[dest]![lane]! - s * this.inverseSpeed[dest]![lane]!;
  }

  /** The access point with the fastest route to `dest` (ties: lower lane id), or -1. */
  bestAccess(access: readonly AccessPoint[], dest: number): number {
    let best = -1;
    let bestTime = Infinity;
    for (let k = 0; k < access.length; k++) {
      const { lane, s } = access[k]!;
      const t = this.timeFrom(dest, lane, s);
      if (t < bestTime || (t === bestTime && t < Infinity && lane < access[best]!.lane)) {
        best = k;
        bestTime = t;
      }
    }
    return best;
  }
}

/** Binary min-heap keyed by cost, ties broken by id for determinism. Allows stale entries. */
class MinHeap {
  private readonly ids: Int32Array;
  private readonly keys: Float64Array;
  size = 0;
  constructor(capacity: number) {
    this.ids = new Int32Array(capacity);
    this.keys = new Float64Array(capacity);
  }
  get firstKey() { return this.keys[0]!; }

  push(id: number, key: number): void {
    let i = this.size++;
    this.ids[i] = id;
    this.keys[i] = key;
    while (i > 0) {
      const parent = (i - 1) >> 1;
      if (!this.less(i, parent)) break;
      this.swap(i, parent);
      i = parent;
    }
  }

  popId(): number {
    const top = this.ids[0]!;
    const lastId = this.ids[--this.size]!;
    const lastKey = this.keys[this.size]!;
    if (this.size > 0) {
      this.ids[0] = lastId;
      this.keys[0] = lastKey;
      let i = 0;
      for (;;) {
        const l = i * 2 + 1;
        const r = l + 1;
        let m = i;
        if (l < this.size && this.less(l, m)) m = l;
        if (r < this.size && this.less(r, m)) m = r;
        if (m === i) break;
        this.swap(i, m);
        i = m;
      }
    }
    return top;
  }

  private less(a: number, b: number): boolean {
    const ka = this.keys[a]!;
    const kb = this.keys[b]!;
    return ka < kb || (ka === kb && this.ids[a]! < this.ids[b]!);
  }

  private swap(a: number, b: number): void {
    const id = this.ids[a]!; this.ids[a] = this.ids[b]!; this.ids[b] = id;
    const key = this.keys[a]!; this.keys[a] = this.keys[b]!; this.keys[b] = key;
  }
}
