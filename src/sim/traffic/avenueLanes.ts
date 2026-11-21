import type { SnapshotIO } from '../snapshot';
import type { Network } from '../network/types';
import type { Routing } from './routing';
import type { Vehicles } from './vehicles';

/** A driver picks between connectors before the fork, while both paths still share a stop line. */
export class AvenueLanes {
  private readonly adjacent: Int32Array;
  readonly alternative: Int32Array;
  private readonly forks: number[] = [];
  private readonly driver: Int32Array;
  private readonly chosen: Int32Array;

  snapshotState(io: SnapshotIO): void {
    io.arrays(this.driver, this.chosen);
  }

  constructor(private readonly network: Network) {
    const n = network.lanes.length;
    this.adjacent = new Int32Array(n).fill(-1);
    this.alternative = new Int32Array(n).fill(-1);
    this.driver = new Int32Array(n);
    this.chosen = new Int32Array(n).fill(-1);
    for (const [a,b] of network.avenuePairs ?? []) {
      this.adjacent[a] = b;
      this.adjacent[b] = a;
    }
    for (const lane of network.lanes) {
      let fork = false;
      for (const entry of lane.next) {
        const connector = network.lanes[entry]!;
        if (connector.kind !== 'connector') continue;
        const peer = this.adjacent[connector.next[0]!]!;
        if (peer < 0) continue;
        const other = lane.next.find(id => network.lanes[id]!.next[0] === peer);
        if (other === undefined) continue;
        this.alternative[entry] = other;
        fork = true;
      }
      if (fork) this.forks.push(lane.id);
    }
  }

  /** Require the same downstream streets all the way to a common lane or destination.
   * Reachability alone could send a driver past a required turn and around the block. */
  private sameRoute(dest: number, a: number, b: number, routing: Routing): boolean {
    while (this.adjacent[a] === b) {
      const nextA = routing.nextHop(dest,a), nextB = routing.nextHop(dest,b);
      if (nextA < 0 || nextB < 0) {
        return Number.isFinite(routing.exit(dest,a)) && Number.isFinite(routing.exit(dest,b));
      }
      const laneA = this.network.lanes[nextA]!, laneB = this.network.lanes[nextB]!;
      a = laneA.kind === 'connector' ? laneA.next[0]! : nextA;
      b = laneB.kind === 'connector' ? laneB.next[0]! : nextB;
      if (a === b) return true;
    }
    return false;
  }

  private load(lane: number, count: Int32Array): number {
    let vehicles = count[lane]!;
    for (const entry of this.network.lanes[lane]!.prev) vehicles += count[entry]!;
    return vehicles;
  }

  update(v: Vehicles, routing: Routing, count: Int32Array, start: Int32Array, order: Int32Array): void {
    for (const fork of this.forks) {
      if (!count[fork]) { this.chosen[fork] = -1; continue; }
      const slot = order[start[fork]!]!;
      const dest = v.dest[slot]!, routed = routing.nextHop(dest,fork);
      const other = routed < 0 ? -1 : this.alternative[routed]!;
      if (other < 0 || this.network.lanes[fork]!.length - v.s[slot]! > 32) {
        this.chosen[fork] = -1;
        continue;
      }
      const a = this.network.lanes[routed]!.next[0]!, b = this.network.lanes[other]!.next[0]!;
      if (!this.sameRoute(dest,a,b,routing)) { this.chosen[fork] = -1; continue; }
      const previous = this.chosen[fork];
      if (this.driver[fork] === v.id[slot] && (previous === routed || previous === other)) continue;
      const loadA = this.load(a,count), loadB = this.load(b,count);
      this.driver[fork] = v.id[slot]!;
      this.chosen[fork] = loadA === loadB ? (a < b ? routed : other) : loadA < loadB ? routed : other;
    }
  }

  choice(lane: number, vehicleId: number): number {
    return this.driver[lane] === vehicleId ? this.chosen[lane]! : -1;
  }
}
