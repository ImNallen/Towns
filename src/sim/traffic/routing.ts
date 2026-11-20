import type { Network } from '../network/types';

/**
 * Next-hop tables: for every destination (sink lane) and every lane, the lane to
 * take next on the fastest free-flow route. Built with a reverse Dijkstra per sink.
 *
 * Vehicles store only their destination index, so routes cost no per-vehicle memory.
 * TODO: congestion-aware costs, recomputed incrementally over several ticks.
 */
export class Routing {
  readonly sinks: readonly number[];
  private readonly nextHops: Int32Array[] = [];
  private readonly costs: Float64Array[] = [];

  constructor(network: Network) {
    this.sinks = network.sinks;
    const n = network.lanes.length;
    const laneCost = new Float64Array(n);
    for (const lane of network.lanes) laneCost[lane.id] = lane.length / lane.speedLimit;

    for (const sink of this.sinks) {
      const cost = new Float64Array(n).fill(Infinity);
      const next = new Int32Array(n).fill(-1);
      const heap = new MinHeap();
      cost[sink] = laneCost[sink]!;
      heap.push(sink, cost[sink]!);
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
    }
  }

  /** Next lane towards `sinks[dest]`, or -1 if `lane` is the sink or it is unreachable. */
  nextHop(dest: number, lane: number): number {
    return this.nextHops[dest]![lane]!;
  }

  canReach(dest: number, lane: number): boolean {
    return this.costs[dest]![lane]! < Infinity;
  }

  /** Free-flow travel time from the start of `lane` to the end of the destination, s. */
  travelTime(dest: number, lane: number): number {
    return this.costs[dest]![lane]!;
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
