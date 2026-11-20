import { endOf, sampleAt, startOf, type PathSample } from './math/polyline';
import type { Lane, Network } from './network/types';
import { Rng } from './rng';
import type { Scenario } from './scenarios/types';
import { IDM, VEHICLE_LENGTH, idmAccel } from './traffic/idm';
import { Routing } from './traffic/routing';
import { Vehicles } from './traffic/vehicles';

/** Fixed simulation timestep, seconds (20 Hz). */
export const DT = 1 / 20;

/** How far ahead a driver looks along their route for leaders, slow lanes and give-ways (m). */
const LOOKAHEAD = 90;
/** Start checking a give-way this far before the merge point (m). */
const YIELD_ZONE = 45;
/** Closer than this to the merge point a driver is committed and stops checking (m). */
const COMMIT_DISTANCE = 1.5;
/** How far upstream of a merge priority traffic is scanned (m). */
const PRIORITY_SCAN = 60;
/** Priority vehicles arriving within [tMe - BEFORE, tMe + AFTER] of us block the merge (s). */
const CONFLICT_BEFORE = 1.5;
const CONFLICT_AFTER = 2.5;

export interface SimStats {
  tick: number;
  /** Simulated seconds. */
  time: number;
  active: number;
  spawned: number;
  completed: number;
  /** Vehicles removed because they could not continue (should stay 0). */
  lost: number;
  meanTripTime: number;
  meanSpeed: number;
  /** Share of active vehicles below 0.5 m/s. */
  stoppedShare: number;
  completedLastMinute: number;
}

interface Spawner {
  lane: number;
  rate: number;
  /** Reachable destination indices, excluding a U-turn back down the same road. */
  destinations: number[];
}

/**
 * The whole simulation state. Deterministic: same scenario + seed + inputs
 * produce bit-identical state on every run and platform.
 */
export class World {
  readonly scenario: Scenario;
  readonly network: Network;
  readonly routing: Routing;
  readonly vehicles: Vehicles;

  private readonly lanes: Lane[];
  private readonly rng: Rng;
  private _tick = 0;

  private readonly laneLen: Float64Array;
  private readonly laneSpeed: Float64Array;
  /** Per-tick spatial index: vehicles bucketed by lane, sorted front to back. */
  private readonly bucketStart: Int32Array;
  private readonly bucketCount: Int32Array;
  private readonly bucketCursor: Int32Array;
  private readonly order: Int32Array;
  /** Position of each slot within its lane bucket (0 = frontmost). */
  private readonly rank: Int32Array;
  /** Smallest `s` on each lane after the last move; used for spawn spacing. */
  private readonly laneMinS: Float64Array;

  private readonly spawners: Spawner[];

  private spawned = 0;
  private completed = 0;
  private lost = 0;
  private tripTimeSum = 0;
  private readonly completedPerSecond = new Uint32Array(60);
  private lastSecond = 0;

  constructor(scenario: Scenario, seed: number, capacity = 4096, initialTick = 0) {
    this._tick = initialTick;
    this.lastSecond = Math.floor(this.time);
    this.scenario = scenario;
    this.network = scenario.network;
    this.lanes = scenario.network.lanes;
    this.routing = new Routing(this.network);
    this.vehicles = new Vehicles(capacity);
    this.rng = new Rng(seed);

    const n = this.lanes.length;
    this.laneLen = Float64Array.from(this.lanes, (l) => l.length);
    this.laneSpeed = Float64Array.from(this.lanes, (l) => l.speedLimit);
    this.bucketStart = new Int32Array(n + 1);
    this.bucketCount = new Int32Array(n);
    this.bucketCursor = new Int32Array(n);
    this.order = new Int32Array(capacity);
    this.rank = new Int32Array(capacity);
    this.laneMinS = new Float64Array(n).fill(Infinity);

    this.spawners = scenario.demand.map((d) => {
      const start = startOf(this.lanes[d.lane]!.path);
      const destinations: number[] = [];
      this.routing.sinks.forEach((sink, idx) => {
        const end = endOf(this.lanes[sink]!.path);
        const dx = end.x - start.x;
        const dy = end.y - start.y;
        const uTurn = dx * dx + dy * dy < 100;
        if (!uTurn && this.routing.canReach(idx, d.lane)) destinations.push(idx);
      });
      return { lane: d.lane, rate: d.rate, destinations };
    });
  }

  get tick(): number {
    return this._tick;
  }

  get time(): number {
    return this._tick * DT;
  }

  step(): void {
    this.buildBuckets();
    this.computeAccelerations();
    this.integrate();
    this.spawn();
    this._tick++;
  }

  // --- Spatial index ----------------------------------------------------------

  private buildBuckets(): void {
    const V = this.vehicles;
    const n = this.lanes.length;
    this.bucketCount.fill(0);
    for (let i = 0; i < V.highWater; i++) if (V.alive[i]) this.bucketCount[V.lane[i]!]!++;
    let total = 0;
    for (let l = 0; l < n; l++) {
      this.bucketStart[l] = total;
      this.bucketCursor[l] = total;
      total += this.bucketCount[l]!;
    }
    this.bucketStart[n] = total;
    for (let i = 0; i < V.highWater; i++) if (V.alive[i]) this.order[this.bucketCursor[V.lane[i]!]!++] = i;

    // Insertion sort each bucket: front (largest s) first, ties by id. Buckets are small and nearly sorted.
    const { s, id } = V;
    for (let l = 0; l < n; l++) {
      const start = this.bucketStart[l]!;
      const end = start + this.bucketCount[l]!;
      for (let a = start + 1; a < end; a++) {
        const slot = this.order[a]!;
        let b = a - 1;
        while (b >= start) {
          const other = this.order[b]!;
          if (s[other]! > s[slot]! || (s[other] === s[slot] && id[other]! < id[slot]!)) break;
          this.order[b + 1] = other;
          b--;
        }
        this.order[b + 1] = slot;
      }
      for (let a = start; a < end; a++) this.rank[this.order[a]!] = a - start;
    }
  }

  /** Slot of the rearmost vehicle on `lane` (caller checks the lane is non-empty). */
  private tail(lane: number): number {
    return this.order[this.bucketStart[lane]! + this.bucketCount[lane]! - 1]!;
  }

  // --- Driving ----------------------------------------------------------------

  private computeAccelerations(): void {
    const V = this.vehicles;
    const { s, v, lane, dest, acc } = V;
    for (let i = 0; i < V.highWater; i++) {
      if (!V.alive[i]) continue;
      const L = lane[i]!;
      const si = s[i]!;
      const vi = v[i]!;
      const d = dest[i]!;
      const v0 = this.laneSpeed[L]!;

      let a: number;
      let leaderFound = false;
      const k = this.rank[i]!;
      if (k > 0) {
        const j = this.order[this.bucketStart[L]! + k - 1]!;
        a = idmAccel(vi, v0, s[j]! - si - VEHICLE_LENGTH, vi - v[j]!);
        leaderFound = true;
      } else {
        a = idmAccel(vi, v0, Infinity, 0);
      }

      let dist = this.laneLen[L]! - si;
      if (this.lanes[L]!.yieldTo.length > 0) a = Math.min(a, this.yieldAccel(L, dist, vi, v0));

      let cur = L;
      let nxt = this.routing.nextHop(d, cur);
      while (nxt >= 0 && dist < LOOKAHEAD) {
        const limit = this.laneSpeed[nxt]!;
        if (limit < vi) a = Math.min(a, (limit * limit - vi * vi) / (2 * Math.max(dist, 2)));
        if (!leaderFound) {
          const j = this.nearestEntering(nxt, cur);
          if (j >= 0) {
            const lead = lane[j] === nxt ? s[j]! : s[j]! - this.laneLen[lane[j]!]!;
            a = Math.min(a, idmAccel(vi, v0, dist + lead - VEHICLE_LENGTH, vi - v[j]!));
            leaderFound = true;
          }
        }
        if (this.lanes[nxt]!.yieldTo.length > 0 && dist < YIELD_ZONE) {
          a = Math.min(a, this.yieldAccel(nxt, dist + this.laneLen[nxt]!, vi, v0));
        }
        dist += this.laneLen[nxt]!;
        cur = nxt;
        nxt = this.routing.nextHop(d, cur);
      }
      acc[i] = Math.max(a, -IDM.maxDecel);
    }
  }

  /**
   * The rearmost vehicle a driver coming from `from` meets on entering `lane`: the tail of
   * `lane`, or a vehicle committed to merging into it from a give-way lane (-1 = none).
   */
  private nearestEntering(lane: number, from: number): number {
    const { s } = this.vehicles;
    let best = -1;
    let bestS = Infinity;
    if (this.bucketCount[lane]! > 0) {
      best = this.tail(lane);
      bestS = s[best]!;
    }
    for (const p of this.lanes[lane]!.prev) {
      if (p === from || this.lanes[p]!.yieldTo.length === 0 || this.bucketCount[p]! === 0) continue;
      const j = this.order[this.bucketStart[p]!]!; // frontmost on the give-way lane
      const front = s[j]! - this.laneLen[p]!;
      if (front > -COMMIT_DISTANCE && front < bestS) {
        best = j;
        bestS = front;
      }
    }
    return best;
  }

  /** Acceleration to respect a give-way at the end of `yieldLane`, `dEnd` meters ahead. */
  private yieldAccel(yieldLane: number, dEnd: number, v: number, v0: number): number {
    if (dEnd < COMMIT_DISTANCE) return Infinity;
    if (!this.mergeBlocked(yieldLane, dEnd, v)) return Infinity;
    return idmAccel(v, v0, dEnd, v); // treat the merge point as a stopped obstacle
  }

  private mergeBlocked(yieldLane: number, dEnd: number, v: number): boolean {
    const tMe = dEnd / Math.max(v, 2);
    const target = this.lanes[yieldLane]!.next[0]!;
    if (tMe < 3 && this.bucketCount[target]! > 0 && this.vehicles.s[this.tail(target)]! < VEHICLE_LENGTH + 1.5) {
      return true; // merge zone still occupied
    }
    for (const p of this.lanes[yieldLane]!.yieldTo) {
      if (this.priorityArrives(p, target, 0, tMe, 0)) return true;
    }
    return false;
  }

  /** Does a priority vehicle on `lane` (or upstream of it) reach the merge around time `tMe`? */
  private priorityArrives(lane: number, towards: number, offset: number, tMe: number, depth: number): boolean {
    const { s, v, dest } = this.vehicles;
    const len = this.laneLen[lane]!;
    const start = this.bucketStart[lane]!;
    const count = this.bucketCount[lane]!;
    for (let q = 0; q < count; q++) {
      const j = this.order[start + q]!;
      const toMerge = offset + len - s[j]!;
      if (toMerge > PRIORITY_SCAN) continue;
      if (this.routing.nextHop(dest[j]!, lane) !== towards) continue;
      const t = toMerge / Math.max(v[j]!, 1);
      if (t > tMe - CONFLICT_BEFORE && t < tMe + CONFLICT_AFTER) return true;
    }
    if (depth < 4 && offset + len < PRIORITY_SCAN) {
      for (const p of this.lanes[lane]!.prev) {
        if (this.lanes[p]!.yieldTo.length > 0) continue;
        if (this.priorityArrives(p, lane, offset + len, tMe, depth + 1)) return true;
      }
    }
    return false;
  }

  private integrate(): void {
    const V = this.vehicles;
    const { s, v, lane, dest, acc } = V;
    for (let i = 0; i < V.highWater; i++) {
      if (!V.alive[i]) continue;
      let vi = v[i]! + acc[i]! * DT;
      if (vi < 0) vi = 0;
      v[i] = vi;
      let si = s[i]! + vi * DT;
      let L = lane[i]!;
      while (si >= this.laneLen[L]!) {
        const nh = this.routing.nextHop(dest[i]!, L);
        if (nh < 0) {
          if (L === this.routing.sinks[dest[i]!]) this.recordArrival(i);
          else this.lost++;
          V.despawn(i);
          break;
        }
        si -= this.laneLen[L]!;
        L = nh;
      }
      s[i] = si;
      lane[i] = L;
    }

    this.laneMinS.fill(Infinity);
    for (let i = 0; i < V.highWater; i++) {
      if (V.alive[i] && s[i]! < this.laneMinS[lane[i]!]!) this.laneMinS[lane[i]!] = s[i]!;
    }
  }

  private spawn(): void {
    const minSpacing = VEHICLE_LENGTH + IDM.minGap + 3;
    for (const sp of this.spawners) {
      // Always draw both numbers so the random stream does not depend on traffic state.
      const arrival = this.rng.next();
      const pick = this.rng.next();
      if (arrival >= sp.rate * DT || sp.destinations.length === 0) continue;
      if (this.laneMinS[sp.lane]! < minSpacing) continue;
      const dest = sp.destinations[Math.floor(pick * sp.destinations.length)]!;
      // Enter no faster than allows a comfortable stop behind whoever is already on the lane.
      const room = this.laneMinS[sp.lane]! - VEHICLE_LENGTH - IDM.minGap;
      const safe = Math.sqrt(2 * IDM.decel * Math.max(room, 0));
      const speed = Math.min(this.laneSpeed[sp.lane]!, 10, safe);
      const slot = this.vehicles.spawn(sp.lane, 0, speed, dest, this.time);
      if (slot >= 0) {
        this.spawned++;
        this.laneMinS[sp.lane] = 0;
      }
    }
  }

  // --- Stats & output -----------------------------------------------------------

  private advanceSeconds(): void {
    const sec = Math.floor(this.time);
    while (this.lastSecond < sec) {
      this.lastSecond++;
      this.completedPerSecond[this.lastSecond % 60] = 0;
    }
  }

  private recordArrival(slot: number): void {
    this.completed++;
    this.tripTimeSum += this.time - this.vehicles.departTime[slot]!;
    this.advanceSeconds();
    this.completedPerSecond[this.lastSecond % 60]!++;
  }

  stats(): SimStats {
    const V = this.vehicles;
    let speedSum = 0;
    let stopped = 0;
    for (let i = 0; i < V.highWater; i++) {
      if (!V.alive[i]) continue;
      speedSum += V.v[i]!;
      if (V.v[i]! < 0.5) stopped++;
    }
    this.advanceSeconds();
    let lastMinute = 0;
    for (const c of this.completedPerSecond) lastMinute += c;
    return {
      tick: this._tick,
      time: this.time,
      active: V.count,
      spawned: this.spawned,
      completed: this.completed,
      lost: this.lost,
      meanTripTime: this.completed > 0 ? this.tripTimeSum / this.completed : 0,
      meanSpeed: V.count > 0 ? speedSum / V.count : 0,
      stoppedShare: V.count > 0 ? stopped / V.count : 0,
      completedLastMinute: lastMinute,
    };
  }

  /**
   * Write per-slot render data: positions as [x, y, heading] triples and ids (-1 = empty slot).
   * Returns the number of slots written.
   */
  writeSnapshot(positions: Float32Array, ids: Int32Array): number {
    const V = this.vehicles;
    const sample: PathSample = { x: 0, y: 0, hx: 0, hy: 0 };
    for (let i = 0; i < V.highWater; i++) {
      if (!V.alive[i]) {
        ids[i] = -1;
        continue;
      }
      sampleAt(this.lanes[V.lane[i]!]!.path, V.s[i]!, sample);
      positions[i * 3] = sample.x;
      positions[i * 3 + 1] = sample.y;
      positions[i * 3 + 2] = Math.atan2(sample.hy, sample.hx);
      ids[i] = V.id[i]!;
    }
    return V.highWater;
  }

  /** FNV-1a hash of the full dynamic state. Equal hashes ⇒ identical simulations. */
  hash(): string {
    let h = 0x811c9dc5;
    const mix = (x: number): void => {
      for (let k = 0; k < 4; k++) {
        h ^= (x >>> (k * 8)) & 0xff;
        h = Math.imul(h, 0x01000193);
      }
    };
    const V = this.vehicles;
    mix(this._tick);
    mix(this.spawned);
    mix(this.completed);
    for (let i = 0; i < V.highWater; i++) {
      if (!V.alive[i]) continue;
      mix(V.id[i]!);
      mix(V.lane[i]!);
      mix(Math.round(V.s[i]! * 1e4));
      mix(Math.round(V.v[i]! * 1e4));
    }
    return (h >>> 0).toString(16).padStart(8, '0');
  }
}
