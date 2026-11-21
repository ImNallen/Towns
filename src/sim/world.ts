import { TrafficConditions } from './traffic/conditions';
import { nextActuatedClock, signalAspect } from './network/signals';
import { parksOn } from './town/parks';
import type { WalkRouting } from './network/walkRouting';
import { endOf, sampleAt, startOf, type PathSample } from './math/polyline';
import type { Lane, Network } from './network/types';
import { Rng } from './rng';
import { sameParcel, zonedLots } from './zoning/lots';
import type { Zoning } from './zoning/paint';
import { accessPoints } from './scenarios/meadow';
import type { Scenario } from './scenarios/types';
import { IDM, idmAccel } from './traffic/idm';
import { Routing } from './traffic/routing';
import { Model, VEHICLES, throughModel, vehicleType } from '../vehicles/catalogue';
import { Vehicles } from './traffic/vehicles';
import { Parking, parkingBays } from './town/parking';
import { CLOCK_START, Town, type TownView } from './town/town';

/** Fixed simulation timestep, seconds (20 Hz). */
export const DT = 1 / 20;
/** The town clock runs one game minute per simulated second. */
const TICKS_PER_MINUTE = 20;

/** How far ahead a driver looks along their route for leaders, slow lanes and give-ways (m). */
const MAX_LENGTH = Math.max(...VEHICLES.map(type => type.length));
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
/** Speed for turning off the road into a driveway (m/s). */
const TURN_SPEED = 4;
/** Minimum free space between bumpers at admission (m). */
const SPAWN_SPACING = IDM.minGap + 3;

export interface SimStats {
  walkers: number;
  walkersCleared: number;
  activeZebras: number;
  zebraWaits: number;
  tick: number;
  /** Simulated seconds. */
  time: number;
  active: number;
  spawned: number;
  completed: number;
  /** Vehicles removed because they could not continue (should stay 0). */
  deliveries: number;
  lost: number;
  meanTripTime: number;
  meanSpeed: number;
  /** Share of active vehicles below 0.5 m/s. */
  stoppedShare: number;
  completedLastMinute: number;
}

interface Spawner {
  model?: Model;
  lane: number;
  rate: number;
  offPeakRate?: number;
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
  routing: Routing;
  readonly traffic: TrafficConditions;
  congestionAware = true;
  private zoning: Zoning = new Map();
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
  /** Smallest rear bumper position on each lane after the last move; used for spawn spacing. */
  private readonly laneMinRear: Float64Array;

  private readonly signalGroups: Int8Array;
  private readonly waitingTicks: Uint16Array;
  readonly signalClocks: Int16Array;
  private readonly actuatedJunctions: number[];
  private readonly movementSignal: Int32Array;

  /** Movement a vehicle just left, for rear-bumper clearance on the receiving lane. */
  private readonly previousMovement: Int32Array;
  private readonly previousVehicle: Int32Array;
  private readonly reserveEntry: Uint8Array;
  private readonly enteredAt: Int32Array;

  private readonly spawners: Spawner[];

  private spawned = 0;
  private completed = 0;
  private deliveries = 0;
  private lost = 0;
  private tripTimeSum = 0;
  private readonly completedPerSecond = new Uint32Array(60);
  private lastSecond = 0;

  constructor(scenario: Scenario, seed: number, capacity = 4096, initialTick = 0, private readonly walkLimit?: number, previousWalking?: WalkRouting) {
    this._tick = initialTick;
    this.lastSecond = Math.floor(this.time);
    this.scenario = scenario;
    this.network = scenario.network;
    this.traffic = new TrafficConditions(this.network);
    this.lanes = scenario.network.lanes;
    this.yieldingMovements = this.lanes.map(() => []);
    for (const lane of this.lanes) {
      for (const priority of lane.crossingYieldTo) this.yieldingMovements[priority]!.push(lane.id);
    }
    const homes = scenario.town?.homes ?? [];
    const bays = scenario.town ? parkingBays(scenario, homes, this.zoning) : [];
    this.routing = new Routing(this.network, [...homes.map(h => h.access), ...bays.map(b => b.access)]);
    this.vehicles = new Vehicles(capacity);
    this.rng = new Rng(seed);
    this.town = scenario.town ? new Town(scenario.town, this.routing.sinks.length, seed, this.routing, new Parking(bays, this.routing.sinks.length + homes.length), scenario.decor.houses, this.network, this.walkLimit, homes.length, previousWalking) : null;

    const n = this.lanes.length;
    this.previousMovement = new Int32Array(capacity).fill(-1);
    this.previousVehicle = new Int32Array(capacity);
    this.reserveEntry = new Uint8Array(n);
    for (const movement of this.network.reservedMovements ?? []) this.reserveEntry[movement] = 2;
    this.signalGroups = new Int8Array(n).fill(-1);
    this.enteredAt = new Int32Array(n).fill(-1);
    const junctions = this.network.junctions ?? [];
    this.waitingTicks = new Uint16Array(junctions.length);
    this.signalClocks = new Int16Array(junctions.length);
    this.actuatedJunctions = [];
    this.movementSignal = new Int32Array(n).fill(-1);
    for (const [index,j] of junctions.entries()) if (j.lights) {
      if (j.actuated) this.actuatedJunctions.push(index);
      for (const arm of j.arms) for (const movement of this.lanes[arm.incoming]!.next) {
        if (j.actuated) this.movementSignal[movement] = index;
        this.signalGroups[movement] = arm.group;
        this.reserveEntry[movement] ||= 1;
      }
    }
    this.laneLen = Float64Array.from(this.lanes, (l) => l.length);
    this.laneSpeed = Float64Array.from(this.lanes, (l) => l.speedLimit);
    this.bucketStart = new Int32Array(n + 1);
    this.bucketCount = new Int32Array(n);
    this.bucketCursor = new Int32Array(n);
    this.order = new Int32Array(capacity);
    this.rank = new Int32Array(capacity);
    this.laneMinRear = new Float64Array(n).fill(Infinity);

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
      return { lane: d.lane, rate: d.rate, offPeakRate: d.offPeakRate, model: d.model, destinations };
    });
  }

  get tick(): number {
    return this._tick;
  }

  get time(): number {
    return this._tick * DT;
  }

  pedestrianPositions() { return this.town?.pedestrianPositions() ?? new Float32Array(0); }

  get walkers() { return this.town?.walkers; }

  step(): void {
    if (this._tick % TICKS_PER_MINUTE === 0) this.traffic.sample(this.vehicles);
    if (this.congestionAware) this.routing.refresh(this._tick, this.traffic.seconds);
    if (this.actuatedJunctions.length && this.walkers) {
      for (const c of this.walkers.graph.crossings) if (c.signal !== undefined) c.clock = this.signalClocks[c.signal]!;
    }
    this.walkers?.step(DT,this.vehicles,this.tick);
    if (this.town && this._tick % TICKS_PER_MINUTE === 0) this.town.update(this.minute(), this, this.admissionsOpen);
    this.buildBuckets();
    this.computeAccelerations();
    this.integrate();
    for (const index of this.actuatedJunctions) {
      const clock = this.signalClocks[index]!;
      const side = this.sideCall(index);
      this.waitingTicks[index] = side && clock < 500 ? this.waitingTicks[index]! + 1 : 0;
      const change = clock >= 500 || this.waitingTicks[index]! >= 480 || !this.approachCall(index, 0, 32);
      this.signalClocks[index] = nextActuatedClock(clock, side && change);
    }
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

  /** Paint edits change driveway targets without remapping cars already on the street. */
  setZoning(zoning: Zoning): void {
    if (!this.town) return;
    const previous = this.town;
    this.installLots(zoning, previous);
    const v = this.vehicles;
    for (let i = 0; i < v.highWater; i++) {
      if (!v.alive[i]) continue;
      if (!this.town.driving(v.owner[i]!)) v.despawn(i);
      else if (v.dest[i]! >= previous.parking.firstDest) v.dest[i] = this.town.driverDestination(v.owner[i]!);
    }
  }

  private installLots(zoning: Zoning, previous: Town): void {
    const base = this.scenario.town!;
    this.zoning = zoning;
    const occupied = previous.occupiedLots();
    const lots = zonedLots(this.scenario, zoning, occupied);
    const surviving = new Map(lots.map(lot => [lot.key, lot]));
    const homes = [...base.homes];
    const free: number[] = [];
    const occupiedSlots = new Map<(typeof lots)[number]['key'], number>();
    for (let h = homes.length; h < previous.spec.homes.length; h++) {
      const lot = previous.spec.homes[h]!.lot;
      if (lot && sameParcel(lot, surviving.get(lot.key))) occupiedSlots.set(lot.key, h);
      else free.push(h);
      homes.push({ access: [], region: 0 });
    }
    let used = 0;
    for (const lot of lots) {
      const h = occupiedSlots.get(lot.key) ?? free[used++] ?? homes.length;
      const access = accessPoints(this.network, { x: lot.streetX, y: lot.streetY });
      homes[h] = { lot, access, region: lot.streetX < 0 ? 0 : 1 };
    }
    const bays = parkingBays(this.scenario, homes, zoning);
    this.routing = new Routing(this.network, [...homes.map(home => home.access), ...bays.map(b => b.access)]);
    this.town = new Town({ ...base, homes }, this.routing.sinks.length, 0, this.routing, new Parking(bays, this.routing.sinks.length + homes.length), this.scenario.decor.houses, this.network, this.walkLimit, base.homes.length, previous.walkers.graph.routing, parksOn(this.scenario.zones,zoning));
    this.town.copyFrom(previous, this.routing, this.minute());
  }

  /**
   * Construct an independent world with new geometry, preserving all running trips.
   * A removal or changed curve that cannot represent a car's current pose is deferred;
   * close admissions, keep stepping this world, and retry when traffic has cleared.
   */
  editNetwork(scenario: Scenario, zoning: Zoning = this.zoning, allowLaneShift = false): { ok: true; world: World } | { ok: false; reason: string } {
    const edited = new World(scenario, 0, this.vehicles.capacity, this.tick, this.walkLimit, this.walkers?.graph.routing);
    if (this.town && scenario.town?.homes.length !== this.scenario.town?.homes.length) {
      return { ok: false, reason: 'The edited map must keep every home.' };
    }
    if (this.town) {
      if (zoning.size || this.town.spec.homes.length > scenario.town!.homes.length) edited.installLots(zoning, this.town);
      else edited.town!.copyFrom(this.town, edited.routing, this.minute());
    }
    const V = this.vehicles;
    const sinkCount = this.routing.sinks.length;
    const minimumHeading = allowLaneShift ? 0.94 : 1 - 1e-6;
    const positionTolerance = allowLaneShift ? 3.75 : 1e-4;
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
      if (edited.town && !edited.town.driving(V.owner[slot]!)) {
        edited.vehicles.despawn(slot);
        continue;
      }
      const dest = this.town && edited.town && V.dest[slot]! >= this.town.parking.firstDest
        ? edited.town.driverDestination(V.owner[slot]!) : destinations[V.dest[slot]!]!;
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
          if (length <= 0 || (dx * pose.hx + dy * pose.hy) / length < minimumHeading) continue;
          const t = Math.max(0, Math.min(1, ((pose.x - pts[k * 2]!) * dx + (pose.y - pts[k * 2 + 1]!) * dy) / (length * length)));
          const s = cum[k]! + t * length;
          // sampleAt resolves a vertex's heading to the following segment, just as rendering does.
          const projected = sampleAt(lane.path, s, { x: 0, y: 0, hx: 0, hy: 0 });
          if (projected.hx * pose.hx + projected.hy * pose.hy < minimumHeading) continue;
          const error = Math.hypot(projected.x - pose.x, projected.y - pose.y);
          if (error > positionTolerance || (best && best.error <= error)) continue;
          best = { lane: lane.id, s, error };
        }
      }
      if (!best) return fail(slot);
      edited.vehicles.laneDelay[slot] = 0;
      edited.vehicles.lane[slot] = best.lane;
      edited.vehicles.s[slot] = best.s;
      edited.vehicles.dest[slot] = dest;
      edited.laneMinRear[best.lane] = Math.min(edited.laneMinRear[best.lane]!, best.s - V.length[slot]!);
    }

    // A split can put two cars on opposite sides of a lane boundary. Check spacing
    // along each driver's new route, rather than only inside individual lanes.
    edited.buildBuckets();
    for (let slot = 0; slot < V.highWater; slot++) {
      if (!edited.vehicles.alive[slot]) continue;
      const lane = edited.vehicles.lane[slot]!;
      const s = edited.vehicles.s[slot]!;
      const rank = edited.rank[slot]!;
      if (rank > 0) {
        const leader = edited.order[edited.bucketStart[lane]! + rank - 1]!;
        if (edited.vehicles.s[leader]! - s < V.length[leader]! - 1e-4) return fail(slot);
      }
      let distance = edited.laneLen[lane]! - s;
      let next = edited.routing.nextHop(edited.vehicles.dest[slot]!, lane);
      while (next >= 0 && distance < MAX_LENGTH) {
        if (edited.bucketCount[next]! > 0
          && distance + edited.vehicles.s[edited.tail(next)]! < V.length[edited.tail(next)]! - 1e-4) return fail(slot);
        distance += edited.laneLen[next]!;
        next = edited.routing.nextHop(edited.vehicles.dest[slot]!, next);
      }
    }
    edited.traffic.copyNoiseFrom(this.traffic);
    for (const index of edited.actuatedJunctions) {
      const point = edited.network.junctions![index]!.point;
      const old = this.actuatedJunctions.find(i => {
        const p = this.network.junctions![i]!.point;
        return p.x === point.x && p.y === point.y;
      });
      if (old !== undefined) {
        edited.signalClocks[index] = this.signalClocks[old]!;
        edited.waitingTicks[index] = this.waitingTicks[old]!;
      }
    }
    edited.rng.copyFrom(this.rng);
    if (!this.town) edited.town = null;
    edited.admissionsOpen = this.admissionsOpen;
    edited.spawned = this.spawned;
    edited.completed = this.completed;
    edited.deliveries = this.deliveries;
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
      const v0 = Math.min(V.topSpeed[i]!, this.laneSpeed[L]!);

      let a: number;
      let leaderFound = false;
      const k = this.rank[i]!;
      if (k > 0) {
        const j = this.order[this.bucketStart[L]! + k - 1]!;
        a = idmAccel(vi, v0, s[j]! - si - V.length[j]!, vi - v[j]!, V.maxAccel[i]!, V.brake[i]!);
        leaderFound = true;
      } else {
        a = idmAccel(vi, v0, Infinity, 0, V.maxAccel[i]!, V.brake[i]!);
      }

      const crossing = this.crossingGap(L,si);
      if (crossing < LOOKAHEAD) {
        const yieldAccel=idmAccel(vi,v0,crossing,vi,V.maxAccel[i]!,V.brake[i]!);
        if (yieldAccel < a) {
          a=yieldAccel;
          const stops=this.walkers!.graph.stops[L]!;
          for (const stop of stops) if (Math.max(0,stop.from)-si === crossing) stop.crossing.yieldingTicks++;
        }
      }
      let dist = this.laneLen[L]! - si;
      if (this.lanes[L]!.yieldTo.length > 0) a = Math.min(a, this.yieldAccel(i, L, dist, vi, v0));

      let cur = L;
      let nxt = this.routing.nextHop(d, cur);
      while (nxt >= 0 && dist < LOOKAHEAD) {
        if (this.reserveEntry[nxt]) {
          if (this.entryBlocked(nxt)) a = Math.min(a, idmAccel(vi, v0, Math.max(0, dist - 4), vi, V.maxAccel[i]!, V.brake[i]!));
        }
        if (this.signalGroups[nxt]! < 0 && (this.lanes[nxt]!.crossingYieldTo.length || this.yieldingMovements[nxt]!.length) && dist < YIELD_ZONE
          && dist >= COMMIT_DISTANCE && this.junctionBlocked(nxt, dist, vi)) {
          a = Math.min(a, idmAccel(vi, v0, dist, vi, V.maxAccel[i]!, V.brake[i]!));
        }
        const crossing = this.crossingGap(nxt,0);
        if (crossing+dist < LOOKAHEAD) a=Math.min(a,idmAccel(vi,v0,Math.max(0,crossing+dist),vi,V.maxAccel[i]!,V.brake[i]!));
        const limit = this.laneSpeed[nxt]!;
        if (limit < vi) a = Math.min(a, (limit * limit - vi * vi) / (2 * Math.max(dist, 2)));
        if (!leaderFound) {
          const j = this.nearestEntering(nxt, cur);
          if (j >= 0) {
            const lead = lane[j] === nxt ? s[j]! : s[j]! - this.laneLen[lane[j]!]!;
            a = Math.min(a, idmAccel(vi, v0, dist + lead - V.length[j]!, vi - v[j]!, V.maxAccel[i]!, V.brake[i]!));
            leaderFound = true;
          }
        }
        if (this.lanes[nxt]!.yieldTo.length > 0 && dist < YIELD_ZONE) {
          a = Math.min(a, this.yieldAccel(i, nxt, dist + this.laneLen[nxt]!, vi, v0));
        }
        dist += this.laneLen[nxt]!;
        cur = nxt;
        nxt = this.routing.nextHop(d, cur);
      }
      // The route ends on `cur`. A building's driveway part-way along it is a turn to slow for;
      // a sink at the lane end is not.
      const exit = nxt < 0 ? this.routing.exit(d, cur) : Infinity;
      const turnSpeed = this.town?.parking.bays[d - this.town.parking.firstDest]?.kind === 'street' ? 1 : TURN_SPEED;
      if (exit < this.laneLen[cur]! && vi > turnSpeed) {
        const toExit = dist - this.laneLen[cur]! + exit;
        a = Math.min(a, (turnSpeed * turnSpeed - vi * vi) / (2 * Math.max(toExit, 2)));
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
      bestS = s[best]! - this.vehicles.length[best]!;
    }
    for (const p of this.lanes[lane]!.prev) {
      if (p === from || (this.lanes[p]!.yieldTo.length === 0 && this.lanes[p]!.crossingYieldTo.length === 0)
        || this.bucketCount[p]! === 0) continue;
      const j = this.order[this.bucketStart[p]!]!; // frontmost on the give-way lane
      const front = s[j]! - this.laneLen[p]!;
      if (front > -COMMIT_DISTANCE && front - this.vehicles.length[j]! < bestS) {
        best = j;
        bestS = front - this.vehicles.length[j]!;
      }
    }
    return best;
  }

  /** Acceleration to respect a give-way at the end of `yieldLane`, `dEnd` meters ahead. */
  private yieldAccel(i: number, yieldLane: number, dEnd: number, v: number, v0: number): number {
    if (dEnd < COMMIT_DISTANCE) return Infinity;
    if (!this.mergeBlocked(yieldLane, dEnd, v)) return Infinity;
    return idmAccel(v, v0, dEnd, v, this.vehicles.maxAccel[i]!, this.vehicles.brake[i]!); // treat the merge point as a stopped obstacle
  }

  /** Reserve the conflict area before entry; vehicles already inside finish clearing it. */
  private approachCall(index: number, group: number, distance: number): boolean {
    const junction = this.network.junctions![index]!;
    for (const arm of junction.arms) {
      if (arm.group !== group || !this.bucketCount[arm.incoming]) continue;
      const driver = this.order[this.bucketStart[arm.incoming]!]!;
      const v = this.vehicles;
      if (v.alive[driver] && v.lane[driver] === arm.incoming
        && this.laneLen[arm.incoming]! - v.s[driver]! < distance
        && this.routing.nextHop(v.dest[driver]!, arm.incoming) >= 0) return true;
    }
    return false;
  }

  private sideCall(index: number): boolean {
    if (this.approachCall(index, 1, 18)) return true;
    if (this.walkers) for (const c of this.walkers.graph.crossings) {
      if (c.signal === index && c.walkGroup === 1 && c.waiting) return true;
    }
    return false;
  }

  private entryBlocked(movement: number): boolean {
    const signal = this.movementSignal[movement]!;
    const clock = signal < 0 ? this.tick : this.signalClocks[signal]!;
    if (this.signalGroups[movement]! >= 0 && signalAspect(this.signalGroups[movement]!, clock) !== 'green') return true;
    if (this.reserveEntry[movement] === 2) for (const sibling of this.lanes[this.lanes[movement]!.prev[0]!]!.next) {
      if (sibling !== movement && (this.bucketCount[sibling]! || this.enteredAt[sibling] === this.tick)) return true;
    }
    for (const other of this.lanes[movement]!.crossingYieldTo) if (this.movementOccupied(other)) return true;
    for (const other of this.yieldingMovements[movement]!) if (this.movementOccupied(other)) return true;
    return false;
  }

  private movementOccupied(other: number): boolean {
    if (this.bucketCount[other]! > 0 || this.enteredAt[other] === this.tick) return true;
    const outgoing = this.lanes[other]!.next[0]!;
    if (this.laneMinRear[outgoing]! >= 0) return false;
    if (this.movementSignal[other]! < 0 || !this.bucketCount[outgoing]) return true;
    const slot = this.tail(outgoing);
    return this.previousVehicle[slot] !== this.vehicles.id[slot] || this.previousMovement[slot] === other;
  }

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
    if (tMe < 3 && this.bucketCount[target]! > 0 && this.vehicles.s[this.tail(target)]! < this.vehicles.length[this.tail(target)]! + 1.5) {
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

  private crossingGap(lane: number, front: number): number {
    let gap=Infinity;
    const stops=this.walkers?.graph.stops[lane];
    if (stops) for (const stop of stops) {
      if (!stop.crossing.occupied && !((stop.crossing.zebra || stop.crossing.walkGroup !== undefined) && stop.crossing.requested)) continue;
      const line=Math.max(0,stop.from);
      if (front <= line) gap=Math.min(gap,line-front);
    }
    return gap;
  }

  private crossingOccupied(lane: number, front: number, length: number): boolean {
    const stops=this.walkers?.graph.stops[lane];
    if (stops) for (const stop of stops) {
      if (stop.crossing.occupied && front >= stop.from && front-length <= stop.to) return true;
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
      const room = this.crossingGap(lane[i]!,s[i]!);
      let si = s[i]! + Math.min(vi * DT,room);
      if (vi*DT >= room) v[i]=0;
      const delay = Math.max(0, DT - (si - s[i]!) / this.laneSpeed[lane[i]!]!);
      V.tripDelay[i] += delay;
      V.laneDelay[i] += delay;
      let L = lane[i]!;
      const d = dest[i]!;
      for (;;) {
        if (si >= this.routing.exit(d, L)) {
          this.recordArrival(i);
          if (owner[i]! < -1 && this.town?.freightArrived(owner[i]!, minute)) this.deliveries++;
          if (owner[i]! >= 0) this.town?.arrived(owner[i]!, minute, V.tripDelay[i]!);
          V.despawn(i);
          break;
        }
        if (si < this.laneLen[L]!) break;
        const nh = this.routing.nextHop(d, L);
        if (nh < 0) {
          this.lost++;
          if (owner[i]! >= 0) this.town?.abandonTrip(owner[i]!);
          V.despawn(i);
          break;
        }
        const enterRoom=this.crossingGap(nh,0);
        if ((this.reserveEntry[nh] && this.entryBlocked(nh)) || si-this.laneLen[L]! >= enterRoom) {
          si=this.laneLen[L]! - 0.0001;
          v[i]=0;
          break;
        }
        si -= this.laneLen[L]!;
        V.laneDelay[i] = 0;
        if (this.movementSignal[L]! >= 0) {
          this.previousVehicle[i] = V.id[i]!;
          this.previousMovement[i] = L;
        }
        if (this.reserveEntry[nh]) this.enteredAt[nh] = this.tick;
        L = nh;
      }
      s[i] = si;
      lane[i] = L;
    }

    this.laneMinRear.fill(Infinity);
    for (let i = 0; i < V.highWater; i++) {
      if (V.alive[i]) this.laneMinRear[lane[i]!] = Math.min(this.laneMinRear[lane[i]!]!, s[i]! - V.length[i]!);
    }
  }

  private spawn(): void {
    const clock = this.minute() % 1440;
    const rush = (clock >= 390 && clock < 570) || (clock >= 960 && clock < 1140);
    for (const sp of this.spawners) {
      // Always draw both numbers so the random stream does not depend on traffic state.
      const arrival = this.rng.next();
      const pick = this.rng.next();
      if (!this.admissionsOpen) continue;
      if (arrival >= (rush ? sp.rate : sp.offPeakRate ?? sp.rate) * DT || sp.destinations.length === 0) continue;
      if (this.laneMinRear[sp.lane]! < SPAWN_SPACING) continue;
      const dest = sp.destinations[Math.floor(pick * sp.destinations.length)]!;
      // Enter no faster than allows a comfortable stop behind whoever is already on the lane.
      const model = sp.model ?? throughModel((pick * sp.destinations.length) % 1);
      const type = vehicleType(model);
      if (this.crossingOccupied(sp.lane,0,type.length)) continue;
      const room = this.laneMinRear[sp.lane]! - IDM.minGap;
      const safe = Math.sqrt(2 * type.brake * Math.max(room, 0));
      const speed = Math.min(this.laneSpeed[sp.lane]!, type.speed, 10, safe);
      const slot = this.vehicles.spawn(sp.lane, 0, speed, dest, this.time, -1, model);
      if (slot >= 0) {
        this.spawned++;
        this.laneMinRear[sp.lane] = -type.length;
      }
    }
  }

  /**
   * Start a resident's car at rest at `s` on `lane`, heading for `dest`. Refused while
   * admissions are closed, when `dest` cannot be reached from there, or when a car is too
   * close ahead or could not stop comfortably behind it.
   */
  trySpawnAt(lane: number, s: number, dest: number, owner: number, model = Model.Estate): boolean {
    if (this.crossingOccupied(lane,s,vehicleType(model).length)) return false;
    if (!this.admissionsOpen || this.routing.timeFrom(dest, lane, s) === Infinity || this.crowded(lane, s, vehicleType(model).length)) return false;
    const slot = this.vehicles.spawn(lane, s, 0, dest, this.time, owner, model);
    if (slot < 0) return false;
    this.spawned++;
    this.laneMinRear[lane] = Math.min(this.laneMinRear[lane]!, s - this.vehicles.length[slot]!);
    return true;
  }

  /** Would a car standing at `s` on `lane` be too close to another? Also checks adjacent lanes. */
  private crowded(lane: number, s: number, length: number): boolean {
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
        if (front - V.length[j]! - s < SPAWN_SPACING) return true;
        continue;
      }
      const room = s - length - IDM.minGap - front;
      if (room < 0 || V.v[j]! * V.v[j]! > 2 * V.brake[j]! * room) return true;
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

  private zebraWaits(): number {
    let count=0;
    const v=this.vehicles;
    if (!this.walkers) return count;
    for (const c of this.walkers.graph.crossings) {
      if (!c.zebra || !c.occupied) continue;
      for (const z of c.lanes) for (let i=0; i<v.highWater; i++) {
        if (v.alive[i] && v.lane[i]===z.lane && v.v[i]!<2 && v.s[i]! <= z.from && z.from-v.s[i]!<8) count++;
      }
    }
    return count;
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
      zebraWaits: this.zebraWaits(),
      activeZebras: this.walkers?.graph.crossings.filter(c => c.zebra && c.occupied).length ?? 0,
      walkers: this.walkers?.count ?? 0,
      walkersCleared: this.walkers?.cleared ?? 0,
      active: V.count,
      spawned: this.spawned,
      completed: this.completed,
      deliveries: this.deliveries,
      lost: this.lost,
      meanTripTime: this.completed > 0 ? this.tripTimeSum / this.completed : 0,
      meanSpeed: V.count > 0 ? speedSum / V.count : 0,
      stoppedShare: V.count > 0 ? stopped / V.count : 0,
      completedLastMinute: lastMinute,
    };
  }

  /**
   * Write per-slot render data: positions as [x, y, heading] triples, ids (-1 = empty slot) and
   * the model selected at departure. Returns the number of slots written.
   */
  writeSnapshot(positions: Float32Array, ids: Int32Array, models: Uint8Array, paint?: Uint8Array): number {
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
      models[i] = V.model[i]!;
      if (paint) {
        const colours = vehicleType(V.model[i]!).colours;
        paint[i] = colours[V.owner[i] === -1 ? V.id[i]! % colours.length : 0]!;
      }
    }
    return V.highWater;
  }

  get treasury() { return this.town?.treasury; }

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
    for (const index of this.actuatedJunctions) { mix(this.signalClocks[index]!); mix(this.waitingTicks[index]!); }
    mix(this.spawned);
    mix(this.completed);
    for (let i = 0; i < V.highWater; i++) {
      if (!V.alive[i]) continue;
      if (this.actuatedJunctions.length && this.previousVehicle[i] === V.id[i]) mix(this.previousMovement[i]!);
      mix(V.id[i]!);
      mix(V.lane[i]!);
      mix(Math.round(V.s[i]! * 1e4));
      mix(Math.round(V.v[i]! * 1e4));
      if (this.town) { mix(V.owner[i]!); mix(V.model[i]!); }
    }
    if (this.town) mix(this.deliveries);
    this.town?.hash(mix);
    return (h >>> 0).toString(16).padStart(8, '0');
  }
}
