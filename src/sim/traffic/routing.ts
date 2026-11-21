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
 * TODO: congestion-aware costs, recomputed incrementally over several ticks.
 */
export class Routing {
  readonly sinks: readonly number[];
  /** Number of destinations: sinks, then building targets. */
  readonly destinations: number;
  private readonly nextHops: Int32Array[] = [];
  private readonly costs: Float64Array[] = [];
  /** Per destination and lane: the `s` at which a vehicle arrives (Infinity = keep driving). */
  private readonly exits: Float64Array[] = [];
  private readonly speed: Float64Array;

  constructor(network: Network, targets: readonly (readonly AccessPoint[])[] = []) {
    this.sinks = network.sinks;
    this.destinations = this.sinks.length + targets.length;
    const n = network.lanes.length;
    const laneCost = new Float64Array(n);
    this.speed = new Float64Array(n);
    for (const lane of network.lanes) {
      laneCost[lane.id] = lane.length / lane.speedLimit;
      this.speed[lane.id] = lane.speedLimit;
    }
    const seeds: (readonly AccessPoint[])[] = [
      ...this.sinks.map((sink) => [{ lane: sink, s: network.lanes[sink]!.length }]),
      ...targets,
    ];

    for (const exitsAt of seeds) {
      const cost = new Float64Array(n).fill(Infinity);
      const next = new Int32Array(n).fill(-1);
      const exit = new Float64Array(n).fill(Infinity);
      const heap = new MinHeap();
      for (const { lane, s } of exitsAt) {
        exit[lane] = s;
        cost[lane] = s / this.speed[lane]!;
        heap.push(lane, cost[lane]!);
      }
      while (heap.size > 0) {
        const lane = heap.popId();
        const c = cost[lane]!;
        for (const p of network.lanes[lane]!.prev) {
          const cand = c + laneCost[p]!;
          if (cand < cost[p]! || (cand === cost[p]! && lane < next[p]!)) {
            cost[p] = cand;
            next[p] = lane;
            heap.push(p, cand);
          }
        }
      }
      this.nextHops.push(next);
      this.costs.push(cost);
      this.exits.push(exit);
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
    return this.costs[dest]![lane]! - s / this.speed[lane]!;
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
  private ids: number[] = [];
  private keys: number[] = [];

  get size(): number {
    return this.ids.length;
  }

  push(id: number, key: number): void {
    this.ids.push(id);
    this.keys.push(key);
    let i = this.ids.length - 1;
    while (i > 0) {
      const parent = (i - 1) >> 1;
      if (!this.less(i, parent)) break;
      this.swap(i, parent);
      i = parent;
    }
  }

  popId(): number {
    const top = this.ids[0]!;
    const lastId = this.ids.pop()!;
    const lastKey = this.keys.pop()!;
    if (this.ids.length > 0) {
      this.ids[0] = lastId;
      this.keys[0] = lastKey;
      let i = 0;
      for (;;) {
        const l = i * 2 + 1;
        const r = l + 1;
        let m = i;
        if (l < this.ids.length && this.less(l, m)) m = l;
        if (r < this.ids.length && this.less(r, m)) m = r;
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
    [this.ids[a], this.ids[b]] = [this.ids[b]!, this.ids[a]!];
    [this.keys[a], this.keys[b]] = [this.keys[b]!, this.keys[a]!];
  }
}
