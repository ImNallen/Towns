import { endOf, sampleAt, startOf, type PathSample } from './math/polyline';
import type { Lane, Network } from './network/types';
import { Rng } from './rng';
import type { Scenario } from './scenarios/types';
import { IDM, VEHICLE_LENGTH, idmAccel } from './traffic/idm';
import { Routing } from './traffic/routing';
import { Vehicles } from './traffic/vehicles';
import { CLOCK_START, Town, type TownView } from './town/town';

/** Fixed simulation timestep, seconds (20 Hz). */
export const DT = 1 / 20;
/** The town clock runs one game minute per simulated second. */
const TICKS_PER_MINUTE = 20;

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
/** A new car needs the car ahead this far beyond its own front bumper (m). */
const SPAWN_SPACING = VEHICLE_LENGTH + IDM.minGap + 3;

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
  private readonly yieldingMovements: number[][];
  private readonly rng: Rng;
  private town: Town | null;
  private _tick = 0;
  private admissionsOpen = true;

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
    this.yieldingMovements = this.lanes.map(() => []);
    for (const lane of this.lanes) {
      for (const priority of lane.crossingYieldTo) this.yieldingMovements[priority]!.push(lane.id);
    }
    this.routing = new Routing(this.network, scenario.town?.homes.map((home) => home.access));
    this.vehicles = new Vehicles(capacity);
    this.rng = new Rng(seed);
    this.town = scenario.town ? new Town(scenario.town, this.routing.sinks.length, seed, this.routing) : null;

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
    if (this.town && this._tick % TICKS_PER_MINUTE === 0) this.town.update(this.minute(), this);
    this.buildBuckets();
    this.computeAccelerations();
    this.integrate();
    this.spawn();
    this._tick++;
  }

  /** Game minutes since midnight before day 1. */
  private minute(): number {
    return Math.floor(this._tick / TICKS_PER_MINUTE) + CLOCK_START;
  }

  /** Pause new arrivals while existing trips drain before retrying a deferred edit. */
  setAdmissions(open: boolean): void {
    this.admissionsOpen = open;
  }

  /**
   * Construct an independent world with new geometry, preserving all running trips.
   * A removal or changed curve that cannot represent a car's current pose is deferred;
   * close admissions, keep stepping this world, and retry when traffic has cleared.
   */
  editNetwork(scenario: Scenario): { ok: true; world: World } | { ok: false; reason: string } {
    const edited = new World(scenario, 0, this.vehicles.capacity, this.tick);
    if (this.town && edited.town?.spec.homes.length !== this.town.spec.homes.length) {
      return { ok: false, reason: 'The edited map must keep every home.' };
    }
    const V = this.vehicles;
    const sinkCount = this.routing.sinks.length;
    const destinations = Array.from({ length: this.routing.destinations }, (_, dest) => {
      if (dest >= sinkCount) {
        // Buildings keep their index across edits; only the lanes that reach them change.
        const target = edited.routing.sinks.length + dest - sinkCount;
        return target < edited.routing.destinations ? target : -1;
      }
      const oldEnd = endOf(this.lanes[this.routing.sinks[dest]!]!.path);
      return edited.routing.sinks.findIndex((candidate) => {
        const end = endOf(edited.lanes[candidate]!.path);
        return Math.hypot(end.x - oldEnd.x, end.y - oldEnd.y) <= 0.25
          && end.hx * oldEnd.hx + end.hy * oldEnd.hy > 0.99;
      });
    });
    const fail = (slot: number): { ok: false; reason: string } => ({
      ok: false,
      reason: `Vehicle ${V.id[slot]} still needs this road to reach its destination. Pause arrivals and let traffic clear before retrying.`,
    });
    edited.vehicles.copyFrom(V);
    for (let slot = 0; slot < V.highWater; slot++) {
      if (!V.alive[slot]) continue;
      const dest = destinations[V.dest[slot]!]!;
      if (dest < 0) return fail(slot);
      const pose = sampleAt(this.lanes[V.lane[slot]!]!.path, V.s[slot]!, { x: 0, y: 0, hx: 0, hy: 0 });
      let best: { lane: number; s: number; error: number } | undefined;
      for (const lane of edited.lanes) {
        if (!edited.routing.canReach(dest, lane.id)) continue;
        const { pts, cum } = lane.path;
        for (let k = 0; k < cum.length - 1; k++) {
          const dx = pts[k * 2 + 2]! - pts[k * 2]!;
          const dy = pts[k * 2 + 3]! - pts[k * 2 + 1]!;
          const length = cum[k + 1]! - cum[k]!;
          if (length <= 0 || (dx * pose.hx + dy * pose.hy) / length < 1 - 1e-6) continue;
          const t = Math.max(0, Math.min(1, ((pose.x - pts[k * 2]!) * dx + (pose.y - pts[k * 2 + 1]!) * dy) / (length * length)));
          const s = cum[k]! + t * length;
          // sampleAt resolves a vertex's heading to the following segment, just as rendering does.
          const projected = sampleAt(lane.path, s, { x: 0, y: 0, hx: 0, hy: 0 });
          if (projected.hx * pose.hx + projected.hy * pose.hy < 1 - 1e-6) continue;
          const error = Math.hypot(projected.x - pose.x, projected.y - pose.y);
          if (error > 1e-4 || (best && best.error <= error)) continue;
          best = { lane: lane.id, s, error };
        }
      }
      if (!best) return fail(slot);
      edited.vehicles.lane[slot] = best.lane;
      edited.vehicles.s[slot] = best.s;
      edited.vehicles.dest[slot] = dest;
      edited.laneMinS[best.lane] = Math.min(edited.laneMinS[best.lane]!, best.s);
    }

    // A split can put two cars on opposite sides of a lane boundary. Check spacing
    // along each driver's new route, rather than only inside individual lanes.
    edited.buildBuckets();
    for (let slot = 0; slot < V.highWater; slot++) {
      if (!V.alive[slot]) continue;
      const lane = edited.vehicles.lane[slot]!;
      const s = edited.vehicles.s[slot]!;
      const rank = edited.rank[slot]!;
      if (rank > 0) {
        const leader = edited.order[edited.bucketStart[lane]! + rank - 1]!;
        if (edited.vehicles.s[leader]! - s < VEHICLE_LENGTH - 1e-4) return fail(slot);
      }
      let distance = edited.laneLen[lane]! - s;
      let next = edited.routing.nextHop(edited.vehicles.dest[slot]!, lane);
      while (next >= 0 && distance < VEHICLE_LENGTH) {
        if (edited.bucketCount[next]! > 0
          && distance + edited.vehicles.s[edited.tail(next)]! < VEHICLE_LENGTH - 1e-4) return fail(slot);
        distance += edited.laneLen[next]!;
        next = edited.routing.nextHop(edited.vehicles.dest[slot]!, next);
      }
    }
    edited.rng.copyFrom(this.rng);
    if (this.town) edited.town!.copyFrom(this.town);
    else edited.town = null;
    edited.admissionsOpen = this.admissionsOpen;
    edited.spawned = this.spawned;
    edited.completed = this.completed;
    edited.lost = this.lost;
    edited.tripTimeSum = this.tripTimeSum;
    edited.completedPerSecond.set(this.completedPerSecond);
    edited.lastSecond = this.lastSecond;
    return { ok: true, world: edited };
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
        if ((this.lanes[nxt]!.crossingYieldTo.length || this.yieldingMovements[nxt]!.length) && dist < YIELD_ZONE
          && dist >= COMMIT_DISTANCE && this.junctionBlocked(nxt, dist, vi)) {
          a = Math.min(a, idmAccel(vi, v0, dist, vi));
        }
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
      if (p === from || (this.lanes[p]!.yieldTo.length === 0 && this.lanes[p]!.crossingYieldTo.length === 0)
        || this.bucketCount[p]! === 0) continue;
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

  /** Reserve the conflict area before entry; vehicles already inside finish clearing it. */
  private junctionBlocked(movement: number, distance: number, speed: number): boolean {
    for (const committed of this.yieldingMovements[movement]!) {
      if (this.bucketCount[committed]! > 0) return true;
    }
    const tEntry = distance / Math.max(speed, 2);
    const clearTime = this.laneLen[movement]! / Math.max(Math.min(speed, this.laneSpeed[movement]!), 3);
    for (const priority of this.lanes[movement]!.crossingYieldTo) {
      if (this.bucketCount[priority]! > 0) return true;
      if (this.junctionApproachArrives(priority, priority, 0, tEntry + clearTime + CONFLICT_AFTER, 0)) return true;
    }
    return false;
  }

  private junctionApproachArrives(
    lane: number, movement: number, offset: number, latest: number, depth: number,
  ): boolean {
    if (depth >= 6 || offset > PRIORITY_SCAN) return false;
    const V = this.vehicles;
    for (const upstream of this.lanes[lane]!.prev) {
      if (this.bucketCount[upstream]! === 0) {
        if (this.junctionApproachArrives(upstream, movement, offset + this.laneLen[upstream]!, latest, depth + 1)) return true;
        continue;
      }
      const first = this.order[this.bucketStart[upstream]!]!;
      const dest = V.dest[first]!;
      if (this.routing.nextHop(dest, upstream) !== lane) continue;
      let next = lane;
      for (let step = 0; step < depth && next !== movement; step++) next = this.routing.nextHop(dest, next);
      if (next !== movement) continue;
      const remaining = offset + this.laneLen[upstream]! - V.s[first]!;
      if (remaining <= PRIORITY_SCAN && remaining / Math.max(V.v[first]!, 1) < latest) return true;
    }
    return false;
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
    const { s, v, lane, dest, acc, owner } = V;
    const minute = this.minute();
    for (let i = 0; i < V.highWater; i++) {
      if (!V.alive[i]) continue;
      let vi = v[i]! + acc[i]! * DT;
      if (vi < 0) vi = 0;
      v[i] = vi;
      let si = s[i]! + vi * DT;
      let L = lane[i]!;
      const d = dest[i]!;
      for (;;) {
        if (si >= this.routing.exit(d, L)) {
          this.recordArrival(i);
          if (owner[i]! >= 0) this.town?.arrived(owner[i]!, minute);
          V.despawn(i);
          break;
        }
        if (si < this.laneLen[L]!) break;
        const nh = this.routing.nextHop(d, L);
        if (nh < 0) {
          this.lost++;
          if (owner[i]! >= 0) this.town?.lost(owner[i]!);
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
    for (const sp of this.spawners) {
      // Always draw both numbers so the random stream does not depend on traffic state.
      const arrival = this.rng.next();
      const pick = this.rng.next();
      if (!this.admissionsOpen) continue;
      if (arrival >= sp.rate * DT || sp.destinations.length === 0) continue;
      if (this.laneMinS[sp.lane]! < SPAWN_SPACING) continue;
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

  /**
   * Start a resident's car at rest at `s` on `lane`, heading for `dest`. Refused while
   * admissions are closed, when `dest` cannot be reached from there, or when a car is too
   * close ahead or could not stop comfortably behind it.
   */
  trySpawnAt(lane: number, s: number, dest: number, owner: number): boolean {
    if (!this.admissionsOpen || this.routing.timeFrom(dest, lane, s) === Infinity || this.crowded(lane, s)) return false;
    const slot = this.vehicles.spawn(lane, s, 0, dest, this.time, owner);
    if (slot < 0) return false;
    this.spawned++;
    if (s < this.laneMinS[lane]!) this.laneMinS[lane] = s;
    return true;
  }

  /** Would a car standing at `s` on `lane` be too close to another? Also checks adjacent lanes. */
  private crowded(lane: number, s: number): boolean {
    const V = this.vehicles;
    const { next, prev } = this.lanes[lane]!;
    for (let j = 0; j < V.highWater; j++) {
      if (!V.alive[j]) continue;
      const other = V.lane[j]!;
      let front: number;
      if (other === lane) front = V.s[j]!;
      else if (next.includes(other)) front = this.laneLen[lane]! + V.s[j]!;
      else if (prev.includes(other)) front = V.s[j]! - this.laneLen[other]!;
      else continue;
      if (front >= s) {
        if (front - s < SPAWN_SPACING) return true;
        continue;
      }
      const room = s - VEHICLE_LENGTH - IDM.minGap - front;
      if (room < 0 || V.v[j]! * V.v[j]! > 2 * IDM.decel * room) return true;
    }
    return false;
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

  /** The residents, their households and the clock; null on maps without a town. Allocates. */
  townView(): TownView | null {
    return this.town?.view(this.minute()) ?? null;
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
      if (this.town) mix(V.owner[i]!);
    }
    this.town?.hash(mix);
    return (h >>> 0).toString(16).padStart(8, '0');
  }
}
