import type { SnapshotIO } from '../snapshot';
import { Model } from '../../vehicles/catalogue';
import { QUALITY } from '../town/qualityOfLife';
import type { Polyline } from '../math/polyline';
import type { Network } from '../network/types';
import type { Vehicles } from './vehicles';

export class TrafficConditions {
  readonly free: Float64Array;
  readonly seconds: Float64Array;
  readonly ratio: Float32Array;
  readonly queue: Uint16Array;
  readonly jamMinutes: Uint16Array;
  readonly noiseDensity: Float32Array;
  private readonly weightedCount: Uint16Array;
  readonly volume: Float32Array;
  worst = -1;
  private readonly observedDelay: Float64Array;
  private readonly approach: Uint8Array;
  private readonly count: Uint16Array;

  snapshotState(io: SnapshotIO): void {
    io.arrays(this.seconds, this.ratio, this.queue, this.jamMinutes, this.noiseDensity);
    io.arrays(this.volume);
    this.worst = io.number(this.worst);
  }

  constructor(private readonly network: Network) {
    this.free = Float64Array.from(network.lanes, lane => lane.length / lane.speedLimit);
    this.seconds = this.free.slice();
    const n = this.free.length;
    this.ratio = new Float32Array(n).fill(1);
    this.approach = Uint8Array.from(network.lanes, lane => Number(lane.next.length > 1 || lane.yieldTo.length > 0 || lane.next.some(id => network.lanes[id]!.prev.length > 1 || network.lanes[id]!.kind === 'connector')));
    this.queue = new Uint16Array(n);
    this.jamMinutes = new Uint16Array(n);
    this.noiseDensity = new Float32Array(n);
    this.weightedCount = new Uint16Array(n);
    this.volume = new Float32Array(n);
    this.observedDelay = new Float64Array(n);
    this.count = new Uint16Array(n);
  }

  /** Noise is a density. A split inherits its parent's density; a join takes a length-weighted mean. */
  copyNoiseFrom(old: TrafficConditions): void {
    if (this.network === old.network) {
      this.noiseDensity.set(old.noiseDensity);
      return;
    }
    for (const lane of this.network.lanes) {
      let exposure = 0;
      for (const previous of old.network.lanes) {
        const density = old.noiseDensity[previous.id]!;
        if (density === 0 || previous.kind !== lane.kind) continue;
        exposure += density * sharedLength(lane.path, previous.path);
      }
      this.noiseDensity[lane.id] = exposure / lane.length;
    }
  }

  /** One sample per town minute. Empty streets gradually recover their free-flow cost. */
  sample(v: Vehicles): void {
    this.queue.fill(0);
    this.count.fill(0);
    this.weightedCount.fill(0);
    this.observedDelay.fill(0);
    this.worst = -1;
    let maxDelay = 0;
    for (let i = 0; i < v.highWater; i++) {
      if (!v.alive[i]) continue;
      const lane = v.lane[i]!;
      this.observedDelay[lane] = Math.max(this.observedDelay[lane]!, v.laneDelay[i]!);
      this.count[lane]++;
      this.weightedCount[lane] += v.model[i] === Model.Lorry ? QUALITY.lorryWeight : 1;
      if (v.v[i]! < 2) this.queue[lane]++;
    }
    for (const lane of this.network.lanes) {
      const i = lane.id;
      this.noiseDensity[i] += (this.weightedCount[i]! / lane.length - this.noiseDensity[i]!) / 240;
      this.volume[i] += (this.count[i]! - this.volume[i]!) / 30;
      const observed = this.free[i]! + this.observedDelay[i]!;
      this.seconds[i] += (observed - this.seconds[i]!) / 10;
      this.ratio[i] = this.seconds[i]! / this.free[i]!;
      this.jamMinutes[i] = this.queue[i]! >= 2 ? Math.min(65535, this.jamMinutes[i]! + 1) : 0;
      const delay = this.seconds[i]! - this.free[i]!;
      if (this.queue[i] && this.approach[i] && delay > maxDelay) {
        this.worst = i;
        maxDelay = delay;
      }
    }
  }

  view() {
    return { ratio: this.ratio, queue: this.queue, worst: this.worst,
      jam: this.jamMinutes.findIndex(minutes => minutes >= 5) };
  }
}
export type TrafficView = ReturnType<TrafficConditions['view']>;

// Compare directed segments since lane IDs, segment endpoints and lane counts can change in an edit.
function sharedLength(path: Polyline, old: Polyline): number {
  let overlap = 0;
  for (let i = 0; i < path.cum.length - 1; i++) {
    const x = path.pts[2*i]!, y = path.pts[2*i+1]!;
    const length = path.cum[i+1]! - path.cum[i]!;
    if (!length) continue;
    const hx = (path.pts[2*i+2]! - x) / length, hy = (path.pts[2*i+3]! - y) / length;
    for (let k = 0; k < old.cum.length - 1; k++) {
      const ax = old.pts[2*k]! - x, ay = old.pts[2*k+1]! - y;
      const bx = old.pts[2*k+2]! - x, by = old.pts[2*k+3]! - y;
      if ((bx - ax)*hx + (by - ay)*hy < 0.99 * (old.cum[k+1]! - old.cum[k]!)) continue;
      if (Math.abs(ax*hy - ay*hx) > 0.25 || Math.abs(bx*hy - by*hx) > 0.25) continue;
      const start = Math.max(0, ax*hx + ay*hy);
      const end = Math.min(length, bx*hx + by*hy);
      overlap += Math.max(0, end - start);
    }
  }
  return overlap;
}
