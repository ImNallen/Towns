import { Model } from '../../vehicles/catalogue';
import { QUALITY } from '../town/qualityOfLife';
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
