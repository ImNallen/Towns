import type { Vec2 } from '../math/vec';

interface Neighbour {
  to: number;
  length: number;
}

/** Allocate only during an edit. Restore surviving shortest-path tree branches first,
 * then propagate improvements from new or shortened connections. */
export class WalkRouting {
  readonly costs: Float64Array[] = [];
  readonly next: Int32Array[] = [];
  private readonly nodes = new Map<string, number>();
  private readonly destinations = new Map<number, number>();

  constructor(
    points: readonly Vec2[],
    edges: readonly Neighbour[][],
    places: readonly number[],
    previous?: WalkRouting,
  ) {
    const surviving = new Int32Array(points.length);
    const newToOld = points.map(({ x, y }, n) => {
      const key = x + '/' + y;
      const old = previous?.nodes.get(key) ?? -1;
      this.nodes.set(key, n);
      return old;
    });
    for (const target of places) {
      this.destinations.set(target, this.costs.length);
      const cost = new Float64Array(points.length).fill(Infinity);
      const next = new Int32Array(points.length).fill(-1);
      this.costs.push(cost);
      this.next.push(next);
      cost[target] = 0;

      const oldPlace = previous?.destinations.get(newToOld[target]!);
      if (previous && oldPlace !== undefined) {
        const oldCost = previous.costs[oldPlace]!;
        const oldNext = previous.next[oldPlace]!;
        // Follow the old tree outward from its root. A child is reusable only
        // after its parent survived and their edge still gives the old cost.
        surviving[0] = target;
        let count = 1;
        for (let i = 0; i < count; i++) {
          const parent = surviving[i]!;
          for (const edge of edges[parent]!) {
            const child = edge.to;
            const oldChild = newToOld[child]!;
            if (cost[child] !== Infinity || oldChild < 0 || oldNext[oldChild] !== newToOld[parent]) continue;
            const candidate = cost[parent]! + edge.length;
            if (candidate !== oldCost[oldChild]) continue;
            cost[child] = candidate;
            surviving[count++] = child;
          }
        }
      }

      const queue: number[] = [];
      const pending = new Uint8Array(points.length);
      const relax = (n: number) => {
        for (const edge of edges[n]!) {
          const candidate = cost[n]! + edge.length;
          if (candidate >= cost[edge.to]!) continue;
          cost[edge.to] = candidate;
          if (!pending[edge.to]) {
            pending[edge.to] = 1;
            queue.push(edge.to);
          }
        }
      };
      for (let n = 0; n < cost.length; n++) if (Number.isFinite(cost[n])) relax(n);
      for (let i = 0; i < queue.length; i++) {
        const n = queue[i]!;
        pending[n] = 0;
        relax(n);
      }
      // Use the same tie break for a cold build and an edit with equal-cost alternatives.
      for (let n = 0; n < cost.length; n++) {
        if (!Number.isFinite(cost[n]) || n === target) continue;
        let best = -1;
        for (const e of edges[n]!) {
          if (cost[e.to]! + e.length !== cost[n]) continue;
          if (best < 0 || cost[e.to]! < cost[best]! || (cost[e.to] === cost[best] && e.to < best)) best = e.to;
        }
        next[n] = best;
      }
    }
  }
}
