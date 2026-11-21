import { walkChance, WALK_CHOICE } from './mode';
import { Walkers, WalkingNetwork, WALK_TRIP_LIMIT } from '../network/walking';
import type { Network } from '../network/types';
import { decodeCellKey } from '../zoning/cells';
import { Parking, sameEntrance, WALK_LIMIT, type Bay } from './parking';
import type { AccessPoint } from '../traffic/routing';
import type { Vec2 } from '../math/vec';
import { Model, vehicleType } from '../../vehicles/catalogue';
import { BUDGET, ECONOMY } from './economy';
import { Treasury, type BudgetView } from './budget';
import { ZONE_KINDS, type ZoneKind } from '../zoning/paint';
import { sameParcel, type Lot } from '../zoning/lots';
import { Rng } from '../rng';
import type { TownSpec } from '../scenarios/types';
import type { Routing } from '../traffic/routing';
import { FIRST_NAMES, SURNAMES } from './names';

/** One simulated second is one game minute. The clock starts at 06:30 on day 1. */
export const MINUTES_PER_DAY = 1440;
export const CLOCK_START = 6 * 60 + 30;

/** What the town needs from the world it lives in. */
export interface TownRoads {
  readonly routing: Routing;
  trySpawnAt(lane: number, s: number, dest: number, owner: number, model: Model): boolean;
}

// Person activity: Home -> Outbound(errand) -> Away(errand) -> Homebound -> Home.
// A person is Outbound or Homebound exactly while one live vehicle has them as owner.
const HOME = 0;
const OUTBOUND = 1;
const AWAY = 2;
const HOMEBOUND = 3;
const WALK_TO_CAR = 4, WALK_TO_DOOR = 5, SEARCH = 6, WALK_BACK = 7, WALK_HOME = 8, RETURN_FAILED = 9, SEEK_HOME = 10;
const WORK = 0;
const SHOP = 1;
const ADULT = 0;

const SHIFT_START = 8 * 60;
const SHIFT_END = 16 * 60;
/** Nobody sets off if they would arrive with less than this much of the shift left (min). */
const MIN_SHIFT = 2 * 60;
/** Each morning an adult leaves up to this many minutes earlier than strictly needed. */
const MAX_EARLY = 25;
const SHOP_OPENS = 17 * 60;
const SHOP_CLOSES = 20 * 60;
const SHOP_STAY = 30;
/** Pantry, in days of food for the whole household. */
const PANTRY_FULL = 4;
const PANTRY_LOW = 1.5;

const HOUSE_CAPACITY = [0, 3, 5, 7];
const MAX_LEVEL = 3;
const MAX_MODEL = Model.SUV;
const IDLE = 0, INBOUND = 1, UNLOADING = 2, RETURNING = 3, WAIT_KERB = 4;
type Demand = Record<ZoneKind, number>;
const GROWTH_THRESHOLD = 360;
const lotZone = (lot: Lot) => lot.designs[0]!.blueprint.zone;
const lotJobs = (lot: Lot) => (lotZone(lot) === 'shops' ? 2 : 4) * lot.columns;
function visibleLot(parcel: Lot, level = 1) {
  const { designs, ...geometry } = parcel;
  const pick = designs[level - 1]!;
  return { ...geometry, design: pick.blueprint.id, variant: pick.variant };
}
const VACANT = 255;
const MAX_MEMBERS = 5;
const EVENT_CAPACITY = 64;
/** Mixed into the world seed so residents never draw from the through-traffic stream. */
const TOWN_SEED = 0x70776e5;

const BOUGHT_CAR = 0;
const NEWER_CAR = 1;
const UPGRADED_HOUSE = 2;
const NEW_JOB = 3;
const CHANGED_JOB = 4;
const LOST_JOB = 5;
const MOVED_IN = 6;
const PARKING_FAILED = 7, NO_WALK_ROUTE = 8;

export type Activity = 'home' | 'outbound' | 'away' | 'homebound' | 'walking' | 'searching';
export type Errand = 'work' | 'shop';
const ACTIVITIES: readonly Activity[] = ['home', 'outbound', 'away', 'homebound', 'walking', 'walking', 'searching', 'walking', 'walking', 'searching', 'searching'];
const ERRANDS: readonly Errand[] = ['work', 'shop'];

/** Each 0..1, where 1 is fully met. */
export interface Needs {
  food: number;
  comfort: number;
  mobility: number;
  security: number;
}

export interface PersonView {
  /** Person index; matches `Vehicles.owner` of their car while they drive. */
  id: number;
  firstName: string;
  role: 'adult' | 'child';
  age: number;
  /** Name of the region they work in. */
  job: string | null;
  activity: Activity;
  /** Mode of the current trip leg. Parking includes a kerbside search or manoeuvre. */
  leg: 'walk' | 'drive' | 'park' | null;
  /** Why they are out; null at home. */
  errand: Errand | null;
  /** Region they are driving to, staying in or coming back from; null at home. */
  place: string | null;
}

export interface HouseholdView {
  lot?: ReturnType<typeof visibleLot>;
  id: number;
  /** Index into `scenario.decor.houses`. */
  home: number;
  /** The region this neighbourhood belongs to. */
  region: string;
  surname: string;
  level: number;
  cars: number;
  drivewayOverflow: number;
  parked: string[];
  carModel: number;
  funds: number;
  /** All wages earned since the start. */
  wages: number;
  /** Days of food left. */
  pantry: number;
  needs: Needs;
  /** Mean of the needs. */
  walkIssue?: string;
  happiness: number;
  members: PersonView[];
}

export type TownEventView = { day: number; minute: number; household: number } & (
  | { kind: 'noWalkRoute'; region: string }
  | { kind: 'parkingFailed'; region: string; shopper: boolean }
  | { kind: 'movedIn' }
  | { kind: 'boughtCar'; cars: number }
  | { kind: 'newerCar'; model: number }
  | { kind: 'upgradedHouse'; level: number }
  /** `person` is the member's `PersonView.id`. */
  | { kind: 'newJob' | 'changedJob' | 'lostJob'; region: string; person: number }
);

export interface BusinessView {
  taxesPaid: number;
  lastDailyCost: number;
  home: number;
  name: string;
  zone: Exclude<ZoneKind, 'residential'>;
  lot: ReturnType<typeof visibleLot>;
  jobs: number;
  filled: number;
  deliveries: number;
  occupied: number;
  capacity: number;
  turnedAway: number;
  unloading: boolean;
  waitingAtKerb: boolean;
  kerb: { x: number; y: number; angle: number };
  loadingBay: { x: number; y: number; angle: number };
  customers: number;
}
export interface TownView {
  overflowCars: Array<Vec2 & { angle: number; model: number }>;
  bays: Array<Pick<Bay, 'kind' | 'x' | 'y' | 'angle'> & { model: number }>;
  parking: { walkedTrips: number; peakWalkers: number; trips: number; parked: number; turnedAway: number; walkMetres: number };
  budget: BudgetView;
  businesses: BusinessView[];
  demand: Demand;
  day: number;
  minuteOfDay: number;
  totals: {
    population: number;
    adults: number;
    employed: number;
    cars: number;
    carsBought: number;
    houseUpgrades: number;
    carUpgrades: number;
    meanFunds: number;
    /** Employed adults working in a region other than their neighbourhood's own. */
    crossCommuters: number;
    localWorkers: number;
  };
  households: HouseholdView[];
  /** Oldest first. */
  events: TownEventView[];
}

const clamp01 = (x: number): number => Math.max(0, Math.min(1, x));
const dayOf = (minute: number): number => Math.floor(minute / MINUTES_PER_DAY) + 1;

/**
 * Households living in the scenario's homes, and the people in them: their jobs, trips and money.
 * Household `h` lives in home `h`. All dynamic state is in typed arrays sized at construction,
 * so `update` never allocates.
 */
export class Town {
  readonly treasury = new Treasury();
  private get dailyRoadUpkeep(): number {
    return (this.spec.roadUpkeep ?? Math.round(this.spec.roadMetres * BUDGET.upkeepPerMetre)) + this.lotUpkeep;
  }

  // Daily gross wages for homes and receipts for shops.
  private readonly taxable: Float64Array;
  private readonly taxesPaid: Float64Array;
  private readonly payroll: Float64Array;
  private readonly lastDailyCost: Float64Array;
  readonly spec: TownSpec;
  /** Routing destination of home 0; home `h` is `homeDest + h`. */
  private readonly homeDest: number;
  private readonly rng: Rng;

  // Households
  private readonly surname: Uint16Array;
  private readonly funds: Float64Array;
  private readonly wages: Float64Array;
  private readonly level: Uint8Array;
  private readonly cars: Uint8Array;
  private readonly carModel: Uint8Array;
  private readonly pantry: Float64Array;
  private readonly firstMember: Int32Array;
  private readonly memberCount: Uint8Array;
  private readonly adults: Uint8Array;

  // People
  private people = 0;
  private readonly household: Int32Array;
  private readonly role: Uint8Array;
  private readonly age: Uint8Array;
  private readonly firstName: Uint16Array;
  /** Place index: off-map region, or region count + local driveway slot. -1 when unemployed. */
  private readonly job: Int32Array;
  private readonly activity: Uint8Array;
  private readonly errand: Uint8Array;
  /** Place visited on the current trip, using the same indexing as job. */
  private readonly at: Int32Array;
  /** Absolute minute they arrived in the region. */
  private readonly arrivedAt: Int32Array;
  /** Absolute minute they want to head home. */
  private readonly until: Int32Array;
  private readonly workedDay: Int32Array;
  /** Today's minutes of slack on the morning commute. */
  private readonly early: Uint8Array;

  private readonly filled: Int32Array;
  private readonly open: Uint8Array;
  private readonly deliveries: Uint16Array;
  private readonly freightState: Uint8Array;
  private readonly loadingGroup: Int32Array;
  private readonly loadingPose: { x: number; y: number; angle: number }[];
  private readonly freightDue: Int32Array;
  private readonly customers: Uint32Array;
  private readonly growth: Demand = { residential: 0, shops: 0, workplaces: 0 };
  private readonly eventPlace = new Array<string>(EVENT_CAPACITY);
  private carsBought = 0;
  private houseUpgrades = 0;
  private carUpgrades = 0;

  private readonly eventDay: Int32Array;
  private readonly eventMinute: Int16Array;
  private readonly eventHousehold: Int16Array;
  private readonly eventKind: Uint8Array;
  private readonly eventDetail: Int16Array;
  private readonly eventPerson: Int16Array;
  private eventHead = 0;
  private eventCount = 0;

  // A car slot is 2 * household + ordinal. A resident keeps that slot until the round trip ends.
  private readonly carBay: Int32Array;
  private readonly driverCar: Int32Array;
  // Target is a bay index. Origin is a routing destination used when restarting from the kerb.
  private readonly target: Int32Array;
  private readonly origin: Int32Array;
  private readonly failed: Uint8Array;
  private readonly circled: Uint8Array;
  private readonly due: Int32Array;
  private readonly denied: Uint16Array;
  private readonly frustration: Uint8Array;
  private readonly lotUpkeep: number;
  private readonly door: Vec2[];
  private readonly outside: AccessPoint[][];
  readonly walkers: Walkers;
  private readonly walkIssue: Int32Array;
  private readonly modeDay: Int32Array;
  private readonly modeRoll: Float64Array;
  private walkedTrips = 0;
  private trips = 0;
  private parked = 0;
  private turnedAway = 0;
  private walkMetres = 0;

  constructor(spec: TownSpec, homeDest: number, seed: number, private readonly routing: Routing, readonly parking: Parking, houses: Vec2[], network: Network, private readonly walkLimit = WALK_TRIP_LIMIT, starterHomes = spec.homes.length) {
    this.spec = spec;
    this.homeDest = homeDest;
    this.rng = new Rng((seed ^ TOWN_SEED) >>> 0);
    const H = spec.homes.length;
    const P = H * MAX_MEMBERS;
    this.carBay = new Int32Array(H * 2).fill(-1);
    this.walkIssue = new Int32Array(H).fill(-1);
    this.modeDay = new Int32Array(P).fill(-1);
    this.modeRoll = new Float64Array(P);
    this.driverCar = new Int32Array(P).fill(-1);
    this.target = new Int32Array(P).fill(-1);
    this.origin = new Int32Array(P).fill(-1);
    this.failed = new Uint8Array(P);
    this.circled = new Uint8Array(P);
    this.due = new Int32Array(P);
    this.denied = new Uint16Array(H);
    this.frustration = new Uint8Array(H);
    this.door = spec.homes.map((h, i) => h.lot ?? houses[i] ?? { x: 0, y: 0 });
    this.walkers = new Walkers(new WalkingNetwork(network, this.door, parking.bays), P);
    parking.walking = this.walkers.graph;
    this.outside = spec.regions.map(r => [{ lane: r.source, s: 0 }]);
    this.lotUpkeep = parking.bays.filter(b => b.kind === 'lot').length * BUDGET.upkeepPerBay;
    this.surname = new Uint16Array(H);
    this.funds = new Float64Array(H);
    this.taxable = new Float64Array(H);
    this.taxesPaid = new Float64Array(H);
    this.payroll = new Float64Array(H);
    this.lastDailyCost = new Float64Array(H);
    this.wages = new Float64Array(H);
    this.level = new Uint8Array(H);
    this.cars = new Uint8Array(H);
    this.carModel = new Uint8Array(H);
    this.pantry = new Float64Array(H);
    this.firstMember = new Int32Array(H);
    this.memberCount = new Uint8Array(H);
    this.adults = new Uint8Array(H);
    this.household = new Int32Array(P);
    this.role = new Uint8Array(P).fill(VACANT);
    this.age = new Uint8Array(P);
    this.firstName = new Uint16Array(P);
    this.job = new Int32Array(P).fill(-1);
    this.activity = new Uint8Array(P);
    this.errand = new Uint8Array(P);
    this.at = new Int32Array(P).fill(-1);
    this.arrivedAt = new Int32Array(P);
    this.until = new Int32Array(P);
    this.workedDay = new Int32Array(P);
    this.early = new Uint8Array(P);
    this.filled = new Int32Array(spec.regions.length + H);
    this.open = new Uint8Array(H);
    this.deliveries = new Uint16Array(H);
    // Two adjacent frontages on the same side can share a service entrance.
    this.loadingGroup = new Int32Array(H).fill(-1);
    this.loadingPose = new Array(H);
    const loadingEntrances = new Map<number, number>();
    for (let h = 0; h < H; h++) {
      const lot = spec.homes[h]!.lot;
      if (!lot || lotZone(lot) === 'residential') continue;
      const { column } = decodeCellKey(lot.key);
      const key = lot.key - (column % 2) * 8;
      const group = loadingEntrances.get(key) ?? h;
      loadingEntrances.set(key, group);
      this.loadingGroup[h] = group;
      const entrance = spec.homes[group]!.lot!;
      const dx = entrance.x - entrance.streetX, dy = entrance.y - entrance.streetY;
      const inset = 5.4 / Math.sqrt(dx * dx + dy * dy);
      this.loadingPose[h] = { x: entrance.streetX + dx * inset, y: entrance.streetY + dy * inset, angle: entrance.angle };
    }
    this.freightState = new Uint8Array(H);
    this.freightDue = new Int32Array(H);
    this.customers = new Uint32Array(H);
    this.eventDay = new Int32Array(EVENT_CAPACITY);
    this.eventMinute = new Int16Array(EVENT_CAPACITY);
    this.eventHousehold = new Int16Array(EVENT_CAPACITY);
    this.eventKind = new Uint8Array(EVENT_CAPACITY);
    this.eventDetail = new Int16Array(EVENT_CAPACITY);
    this.eventPerson = new Int16Array(EVENT_CAPACITY);

    for (let h = 0; h < starterHomes; h++) this.moveIn(h, this.people);
    this.jobMarket(routing, CLOCK_START);
  }

  private moveIn(h: number, start: number): void {
    const rng = this.rng;
    this.wages[h] = 0;
    this.surname[h] = rng.int(SURNAMES.length);
    const adults = rng.next() < 0.6 ? 2 : 1;
    const children = rng.int(4);
    this.firstMember[h] = start;
    this.memberCount[h] = adults + children;
    this.adults[h] = adults;
    for (let k = 0; k < adults + children; k++) {
      const p = start + k;
      this.people = Math.max(this.people, p + 1);
      this.activity[p] = HOME;
      this.driverCar[p] = this.origin[p] = this.target[p] = -1;
      this.due[p] = this.failed[p] = this.circled[p] = 0;
      this.at[p] = this.job[p] = -1;
      this.errand[p] = this.workedDay[p] = this.until[p] = this.arrivedAt[p] = 0;
      this.household[p] = h;
      this.role[p] = k < adults ? ADULT : 1;
      this.age[p] = k < adults ? 24 + rng.int(36) : rng.int(18);
      this.firstName[p] = rng.int(FIRST_NAMES.length);
      this.early[p] = rng.int(MAX_EARLY);
    }
    this.funds[h] = ECONOMY.initialFunds + rng.int(ECONOMY.initialFundsRange);
    this.level[h] = 1;
    this.cars[h] = 1;
    this.parkAtHome(h * 2);
    this.carModel[h] = this.funds[h]! >= ECONOMY.carPrice[Model.Estate] && this.memberCount[h]! > adults
      ? Model.Estate : Model.Hatchback;
    this.pantry[h] = 2 + rng.next() * 2;
  }

  occupiedLots(): Lot[] {
    return this.spec.homes.flatMap((home, h) => (this.level[h] || this.open[h]) && home.lot ? [home.lot] : []);
  }

  private departed(p: number): boolean {
    return p >= 0 && this.role[p] === VACANT;
  }

  private moveOut(h: number): void {
    for (let p = this.firstMember[h]!; p < this.firstMember[h]! + this.memberCount[h]!; p++) {
      this.role[p] = VACANT;
      this.job[p] = -1;
    }
    for (let car = 2 * h; car < 2 * h + this.cars[h]!; car++) this.assign(car, -1);
    this.memberCount[h] = this.level[h] = 0;
    for (let i = 0; i < EVENT_CAPACITY; i++) {
      if (this.eventHousehold[i] === h) this.eventHousehold[i] = -1;
    }
  }

  /** Preserve resident IDs and the random stream when edits resize the home and person arrays. */
  copyFrom(source: Town, routing: Routing, minute: number): boolean {
    let walkersPreserved = true;
    if (source.spec.homes.length > this.spec.homes.length || source.spec.regions.length !== this.spec.regions.length) {
      throw new Error('Town copy requires enough home slots and the same regions');
    }
    this.rng.copyFrom(source.rng);
    this.walkedTrips = source.walkedTrips;
    this.walkers.peak = source.walkers.peak;
    this.trips = source.trips;
    this.parked = source.parked;
    this.turnedAway = source.turnedAway;
    this.walkMetres = source.walkMetres;
    const index = new Map(this.parking.bays.map((b, i) => [b.key, i]));
    const remap = (b: number) => b < 0 ? -1 : index.get(source.parking.bays[b]!.key) ?? -1;
    this.parking.occupant.fill(-1);
    this.carBay.fill(-1);
    for (let car = 0; car < source.carBay.length; car++) {
      const b = remap(source.carBay[car]!);
      this.assign(car, b);
    }
    for (let p = 0; p < source.people; p++) this.target[p] = remap(source.target[p]!);
    this.treasury.copyFrom(source.treasury);
    for (const key of [
      'walkIssue', 'modeDay', 'modeRoll', 'origin', 'driverCar', 'failed', 'circled', 'due', 'denied', 'frustration',
      'taxable', 'taxesPaid', 'payroll', 'lastDailyCost', 'surname', 'funds', 'wages', 'level', 'cars', 'carModel', 'pantry', 'firstMember', 'memberCount', 'adults',
      'household', 'role', 'age', 'firstName', 'job', 'activity', 'errand', 'at', 'arrivedAt', 'until', 'workedDay',
      'deliveries', 'freightState', 'freightDue', 'open', 'customers', 'early', 'eventDay', 'eventMinute', 'eventHousehold', 'eventKind', 'eventDetail', 'eventPerson',
    ] as const) this[key].set(source[key]);
    for (let p = 0; p < source.people; p++) {
      const origin = this.origin[p]!;
      if (origin >= source.parking.firstDest) {
        const bay = remap(origin - source.parking.firstDest);
        this.origin[p] = bay < 0 ? this.destination(this.at[p]!) : this.parking.firstDest + bay;
      }
    }
    Object.assign(this.growth, source.growth);
    Object.assign(this.eventPlace, source.eventPlace);
    this.eventHead = source.eventHead;
    this.eventCount = source.eventCount;
    let closed = false;
    for (let h = 0; h < source.spec.homes.length; h++) {
      const old = source.spec.homes[h]!.lot;
      if (!old || sameParcel(old, this.spec.homes[h]!.lot)) continue;
      // Preserve tax on earnings already recorded even if the payer leaves before settlement.
      if (source.level[h]) this.treasury.today.homes += source.dailyTax(h);
      if (source.open[h]) {
        const shop = lotZone(old) === 'shops';
        const earnedTax = shop ? Math.round(source.taxable[h]! * BUDGET.shopTax) : source.dailyTax(h);
        this.treasury.today[shop ? 'shops' : 'workplaces'] += earnedTax;
      }
      this.taxable[h] = this.taxesPaid[h] = this.payroll[h] = this.lastDailyCost[h] = 0;
      if (this.level[h]) this.moveOut(h);
      if (!this.open[h]) continue;
      closed = true;
      this.deliveries[h] = 0;
      this.freightState[h] = 0;
      this.freightDue[h] = 0;
      this.open[h] = this.customers[h] = 0;
      const place = h + this.spec.regions.length;
      for (let p = 0; p < source.people; p++) {
        if (this.job[p] === place) {
          this.job[p] = -1;
          this.record(minute, this.household[p]!, LOST_JOB, place, p, source.placeName(place));
        }
        if (this.at[p] === place) {
          if (this.driverCar[p]! >= 0 && this.role[p] !== VACANT) this.parkAtHome(this.driverCar[p]!);
          this.driverCar[p] = -1;
          this.activity[p] = HOME;
          this.at[p] = -1;
          this.origin[p] = this.target[p] = -1;
          this.due[p] = 0;
        }
      }
    }
    for (let h = 0; h < this.level.length; h++) {
      if (!this.level[h]) continue;
      for (let car = 2 * h; car < 2 * h + this.cars[h]!; car++) {
        if (this.carBay[car]! < 0 && !this.driverCar.includes(car)) this.parkAtHome(car);
      }
    }
    this.people = source.people;
    this.carsBought = source.carsBought;
    this.houseUpgrades = source.houseUpgrades;
    this.carUpgrades = source.carUpgrades;
    for (let p = 0; p < this.people; p++) {
      if (source.walkers.goal[p]! < 0 || this.role[p] === VACANT || this.activity[p] === HOME) continue;
      const old = source.walkers;
      const goal = old.goal[p]!;
      const bay = goal < source.door.length ? -1 : remap(goal - source.door.length);
      const dest = goal < source.door.length ? goal : bay < 0 ? -1 : this.door.length + bay;
      const n = old.node[p]!;
      const a = old.graph.points[n]!;
      const b = old.graph.points[old.graph.next[goal]![n]!] ?? a;
      const t = old.along[p]! / (Math.hypot(b.x-a.x,b.y-a.y) || 1);
      const x = a.x + t*(b.x-a.x), y = a.y + t*(b.y-a.y);
      const graph = this.walkers.graph;
      let nearest = -1, along = 0, distance = 0.05;
      for (let i = 0; i < graph.points.length; i++) {
        if (!Number.isFinite(graph.costs[dest]?.[i])) continue;
        const point = graph.points[i]!;
        const next = graph.points[graph.next[dest]![i]!] ?? point;
        const dx = next.x-point.x, dy = next.y-point.y;
        const length = Math.hypot(dx,dy);
        const s = Math.min(length, Math.max(0, ((x-point.x)*dx+(y-point.y)*dy)/(length || 1)));
        const ratio = s/(length || 1);
        const d = Math.hypot(x-point.x-ratio*dx,y-point.y-ratio*dy);
        if (d < distance) { distance = d; nearest = i; along = s; }
      }
      if (nearest < 0) {
        walkersPreserved = false;
        this.lost(p);
        continue;
      }
      this.walkers.start(p, dest, dest, this.age[p]!);
      this.walkers.node[p] = nearest;
      this.walkers.along[p] = along;
    }
    if (closed) this.jobMarket(routing, minute);
    else {
      this.filled.fill(0);
      for (let p = 0; p < this.people; p++) if (this.job[p]! >= 0) this.filled[this.job[p]!]++;
    }
    return walkersPreserved;
  }

  /** Advance one game minute. `minute` counts from midnight before day 1. */
  update(minute: number, roads: TownRoads, allowDepartures: boolean): void {
    if (minute % 60 === 0) this.grow(minute, roads.routing);
    const clock = minute % MINUTES_PER_DAY;
    if (clock === 0) this.midnight(minute, roads.routing);
    this.dispatchFreight(minute, roads);
    const day = dayOf(minute);
    for (let p = 0; p < this.people; p++) {
      if (this.role[p] !== ADULT) continue;
      if (this.walkers.goal[p]! >= 0 || minute < this.due[p]!) continue;
      const phase = this.activity[p];
      if (phase === WALK_TO_CAR || phase === SEARCH) this.startDrive(p, roads, minute);
      else if (phase === WALK_TO_DOOR || phase === WALK_HOME) this.enterDoor(p, minute);
      else if (phase === RETURN_FAILED || phase === WALK_BACK || phase === SEEK_HOME) this.leaveRegion(p, roads, minute);
      else if (allowDepartures && this.activity[p] === HOME) this.leaveHome(p, day, clock, roads);
      else if (this.activity[p] === AWAY && minute >= this.until[p]!) {
        if (this.at[p]! < this.spec.regions.length) { this.leaveRegion(p, roads, minute); continue; }
        if (this.driverCar[p]! < 0) {
          this.activity[p] = WALK_HOME;
          this.walkLeg(p, this.at[p]! - this.spec.regions.length, this.household[p]!);
          this.payWork(p);
        } else {
          this.activity[p] = WALK_BACK;
          this.walkLeg(p, this.at[p]! - this.spec.regions.length, this.bayPlace(p, false));
        }
      }
    }
  }

  /** Owner -1 is through traffic. Freight owners -2 and below identify their business slot. */
  private dispatchFreight(minute: number, roads: TownRoads): void {
    for (let h = 0; h < this.open.length; h++) {
      if (!this.open[h] || minute < this.freightDue[h]!) continue;
      const home = this.spec.homes[h]!;
      const depot = this.spec.regions[home.region]!;
      const model = lotZone(home.lot!) === 'shops' ? Model.DeliveryVan : Model.Lorry;
      const owner = -2 - h;
      const access = roads.routing.bestAccess(home.access, depot.sink);
      if (access < 0) continue;
      if (this.freightState[h] === WAIT_KERB && !this.loadingBusy(h)) {
        this.freightState[h] = UNLOADING;
        this.freightDue[h] = minute + 15;
        continue;
      }
      if (this.freightState[h] === UNLOADING) {
        const start = home.access[access]!;
        if (roads.trySpawnAt(start.lane, start.s, depot.sink, owner, model)) this.freightState[h] = RETURNING;
      } else if (this.freightState[h] === IDLE && roads.trySpawnAt(depot.source, 0, this.homeDest + h, owner, model)) {
        this.freightState[h] = INBOUND;
      }
    }
  }

  private loadingBusy(h: number): boolean {
    for (let i = 0; i < this.freightState.length; i++) {
      if (this.loadingGroup[i] === this.loadingGroup[h] && this.freightState[i] === UNLOADING) return true;
    }
    return false;
  }

  freightArrived(owner: number, minute: number): boolean {
    const h = -2 - owner;
    if (this.freightState[h] === INBOUND) {
      this.deliveries[h]++;
      const waiting = this.loadingBusy(h);
      this.freightState[h] = waiting ? WAIT_KERB : UNLOADING;
      this.freightDue[h] = waiting ? minute : minute + 15;
      return true;
    }
    this.freightState[h] = IDLE;
    const jobs = lotJobs(this.spec.homes[h]!.lot!);
    this.freightDue[h] = minute + Math.ceil(MINUTES_PER_DAY / (1 + jobs / 2));
    return false;
  }

  private demandFor(zone: ZoneKind): number {
    let jobs = 0, adults = 0, people = 0, shops = 0, plannedShops = 0;
    let workers = 0;
    for (const filled of this.filled) workers += filled;
    for (const region of this.spec.regions) jobs += region.jobs;
    for (let h = 0; h < this.spec.homes.length; h++) {
      if (this.level[h]) {
        adults += this.adults[h]!;
        people += this.memberCount[h]!;
        continue;
      }
      const lot = this.spec.homes[h]!.lot;
      if (!lot) continue;
      // Vacant serviced land counts as a quarter of its eventual supply.
      const supply = this.open[h] ? 1 : 0.25;
      if (lotZone(lot) === 'residential') {
        adults += 0.4;
        people += 0.8;
      } else {
        jobs += lotJobs(lot) * supply;
        if (lotZone(lot) === 'shops') {
          if (this.open[h]) shops++;
          else plannedShops++;
        }
      }
    }
    if (zone === 'shops') return Math.round(100 * Math.max(0, people - 8 * shops) / (people + 8 + 2 * plannedShops));
    const vacancies = Math.max(0, jobs - workers);
    const jobseekers = Math.max(0, adults - workers);
    const totalPressure = Math.max(1, adults + jobseekers + jobs + vacancies);
    if (zone === 'workplaces') return Math.round(100 * (adults + jobseekers) / totalPressure);
    return Math.round(100 * (jobs + vacancies) / totalPressure);
  }

  private grow(minute: number, routing: Routing): void {
    for (const zone of ZONE_KINDS) {
      let next = -1, key = Infinity;
      for (let h = 0; h < this.spec.homes.length; h++) {
        const lot = this.spec.homes[h]!.lot;
        if (lot && lotZone(lot) === zone && !this.level[h] && !this.open[h] && lot.key < key) {
          next = h;
          key = lot.key;
        }
      }
      if (next < 0) { this.growth[zone] = 0; continue; }
      this.growth[zone] += this.demandFor(zone);
      if (this.growth[zone] < GROWTH_THRESHOLD) continue;
      this.growth[zone] -= GROWTH_THRESHOLD;
      if (zone === 'residential') {
        this.moveIn(next, next * MAX_MEMBERS);
        this.record(minute, next, MOVED_IN, 0);
      } else this.open[next] = 1;
      this.jobMarket(routing, minute);
    }
  }

  driving(p: number): boolean {
    if (p < -1) return this.freightState[-2 - p] === INBOUND || this.freightState[-2 - p] === RETURNING;
    return p < 0 || (!this.departed(p) && (this.activity[p] === OUTBOUND || this.activity[p] === HOMEBOUND));
  }

  private placeName(r: number): string {
    return this.spec.regions[r]?.name ?? this.spec.homes[r - this.spec.regions.length]!.lot!.designs[0]!.blueprint.name;
  }

  private destination(r: number): number {
    return this.spec.regions[r]?.sink ?? this.homeDest + r - this.spec.regions.length;
  }

  private wage(r: number): number {
    return this.spec.regions[r]?.wage ?? ECONOMY.localWage;
  }

  /** A resident's car reached its destination. */
  arrived(p: number, minute: number): void {
    if (this.activity[p] !== HOMEBOUND && this.activity[p] !== OUTBOUND) return;
    const back = this.activity[p] === HOMEBOUND;
    const home = this.household[p]!;
    const place = back ? home : this.at[p]! - this.spec.regions.length;
    if (place < 0) {
      this.activity[p] = WALK_TO_DOOR;
      this.enterDoor(p, minute);
      return;
    }
    const bay = this.target[p]!;
    if (!back && (bay < 0 || this.parking.occupant[bay]! >= 0)) {
      if (this.circled[p] !== 1 || bay >= 0) this.origin[p] = bay >= 0 ? this.parking.firstDest + bay : this.homeDest + place;
      this.activity[p] = SEARCH;
      this.due[p] = minute + 1;
      return;
    }
    if (back && bay >= 0 && this.parking.occupant[bay]! >= 0) {
      this.origin[p] = this.parking.firstDest + bay;
      this.activity[p] = SEEK_HOME;
      this.due[p] = minute + 1;
      return;
    }
    const car = this.driverCar[p]!;
    if (bay >= 0 && this.parking.occupant[bay]! < 0) this.assign(car, bay);
    else this.assign(car, -1); // Home driveway apron.
    const from = this.bayPlace(p, back);
    const distance = this.walkers.graph.distance(from, place);
    if (this.carBay[car]! >= 0) {
      this.parked++;
      this.walkMetres += distance;
    }
    this.activity[p] = back ? WALK_HOME : WALK_TO_DOOR;
    this.walkLeg(p, from, place);
  }

  private enterDoor(p: number, minute: number): void {
    if (this.activity[p] === WALK_HOME) {
      this.activity[p] = HOME;
      if (!this.failed[p] && this.errand[p] === SHOP) this.buyGroceries(this.household[p]!, this.at[p]!);
      this.driverCar[p] = -1;
      if (this.failed[p] && this.errand[p] === SHOP) this.due[p] = minute + 180;
      return;
    }
    this.activity[p] = AWAY;
    const slot = this.at[p]! - this.spec.regions.length;
    if (slot >= 0 && this.errand[p] === SHOP) this.customers[slot]++;
    this.arrivedAt[p] = minute;
    this.until[p] = this.errand[p] === WORK
      ? (this.workedDay[p]! - 1) * MINUTES_PER_DAY + SHIFT_END : minute + SHOP_STAY;
  }

  private bayPlace(p: number, home: boolean): number {
    const b = this.carBay[this.driverCar[p]!]!;
    return b >= 0 ? this.door.length + b : home ? this.household[p]! : this.at[p]! - this.spec.regions.length;
  }

  private walkLeg(p: number, from: number, to: number): void {
    if (!this.walkers.start(p, from, to, this.age[p]!)) this.lost(p);
  }

  private assign(car: number, bay: number): void {
    const old = this.carBay[car]!;
    if (old >= 0) this.parking.occupant[old] = -1;
    this.carBay[car] = bay;
    if (bay >= 0) this.parking.occupant[bay] = car;
  }

  private parkAtHome(car: number): void {
    const h = Math.floor(car / 2);
    const door = this.door[h]!;
    let best = -1, distance = WALK_LIMIT * WALK_LIMIT;
    for (let i = 0; i < this.parking.bays.length; i++) {
      const b = this.parking.bays[i]!;
      if (this.parking.occupant[i]! >= 0) continue;
      if (b.home === h && b.kind === 'driveway') { best = i; break; }
      if (b.kind !== 'street') continue;
      const homeAccess = this.spec.homes[h]!.access;
      if (!sameEntrance(homeAccess, b.access) && (this.routing.bestAccess(homeAccess, this.parking.firstDest + i) < 0
        || this.routing.bestAccess(b.access, this.homeDest + h) < 0)) continue;
      const dx = door.x - b.x, dy = door.y - b.y;
      const d = dx * dx + dy * dy;
      if (d < distance) { best = i; distance = d; }
    }
    this.assign(car, best);
  }

  driverDestination(p: number): number {
    if (this.target[p]! >= 0) return this.parking.firstDest + this.target[p]!;
    return this.activity[p] === HOMEBOUND ? this.homeDest + this.household[p]! : this.destination(this.at[p]!);
  }

  /** A resident's car was removed without arriving: the trip is abandoned at home. */
  lost(p: number): void {
    if (this.driverCar[p]! >= 0) this.parkAtHome(this.driverCar[p]!);
    this.driverCar[p] = -1;
    this.activity[p] = HOME;
  }

  // --- Trips --------------------------------------------------------------------

  private leaveHome(p: number, day: number, clock: number, roads: TownRoads): void {
    const h = this.household[p]!;

    const job = this.job[p]!;
    if (job >= 0 && this.workedDay[p] !== day) {
      const travel = this.outTime(h, job, roads.routing);
      if (clock >= SHIFT_START - travel - this.early[p]! && clock + travel <= SHIFT_END - MIN_SHIFT) {
        if (this.depart(p, WORK, job, day)) this.workedDay[p] = day;
        return;
      }
    }
    if (clock < SHOP_OPENS || clock >= SHOP_CLOSES || this.pantry[h]! >= PANTRY_LOW || this.shopping(h)) return;
    const shop = this.nearestShop(h, roads.routing);
    if (shop >= 0) this.depart(p, SHOP, shop, day);
  }

  private depart(p: number, errand: number, region: number, day: number): boolean {
    const h = this.household[p]!;
    const local = region - this.spec.regions.length;
    const graph = this.walkers.graph;
    const distance = graph.distance(h, local);
    let youngFamily = false, carNearDestination = false;
    for (let i = this.firstMember[h]!; i < this.firstMember[h]! + this.memberCount[h]!; i++) {
      if (this.age[i]! < 8) youngFamily = true;
    }
    for (let car = 2*h; car < 2*h + this.cars[h]!; car++) {
      const bay = this.carBay[car]!;
      if (bay < 0) continue;
      const origin = this.door.length + bay;
      if (graph.distance(origin,local) < graph.distance(origin,h)) carNearDestination = true;
    }
    if (local >= 0 && distance > this.walkLimit && this.modeDay[p] !== 2*day+errand) {
      const a = this.door[h]!, b = this.door[local]!;
      if ((a.x-b.x)**2+(a.y-b.y)**2 < this.walkLimit*this.walkLimit) {
        this.walkIssue[h]=region;
        this.record((day-1)*MINUTES_PER_DAY + (errand === SHOP ? SHOP_OPENS : SHIFT_START), h, NO_WALK_ROUTE, errand, p, this.placeName(region));
        this.modeDay[p]=2*day+errand;
      }
    }
    const chance = walkChance(distance, this.walkLimit, !this.cars[h], errand === SHOP, youngFamily, carNearDestination);
    if (chance > 0 && this.modeDay[p] !== 2*day + errand) {
      this.modeDay[p] = 2*day + errand;
      this.modeRoll[p] = this.rng.next();
    }
    if (this.modeRoll[p]! < chance) {
      this.walkIssue[h]=-1;
      this.errand[p] = errand;
      this.at[p] = region;
      this.failed[p] = 0;
      this.activity[p] = WALK_TO_DOOR;
      this.walkLeg(p, h, local);
      this.walkedTrips++;
      return true;
    }
    if (this.freeCars(h) <= 0) {
      if (!this.cars[h]) this.frustration[h] = 2;
      return false;
    }
    let car = h * 2;
    for (let k = 0; k < this.memberCount[h]!; k++) {
      if (this.driverCar[this.firstMember[h]! + k] === car) { car++; break; }
    }
    this.trips++;
    this.driverCar[p] = car;
    this.target[p] = -1;
    this.origin[p] = -1;
    this.failed[p] = this.circled[p] = 0;
    this.activity[p] = WALK_TO_CAR;
    this.errand[p] = errand;
    this.at[p] = region;
    this.walkLeg(p, h, this.bayPlace(p, true));
    return true;
  }

  private originAccess(p: number): AccessPoint[] {
    const origin = this.origin[p]!;
    if (origin >= this.parking.firstDest) return this.parking.bays[origin - this.parking.firstDest]!.access;
    if (origin >= this.homeDest) return this.spec.homes[origin - this.homeDest]!.access;
    const bay = this.carBay[this.driverCar[p]!]!;
    return this.parking.bays[bay]?.access ?? this.spec.homes[this.household[p]!]!.access;
  }

  /** Search both on the far side of the block and on returning to the destination frontage. */
  private circleBlock(p: number, local: number, access: AccessPoint[], roads: TownRoads): boolean {
    const stage = this.circled[p]!;
    if (stage >= 2) return false;
    const destination = this.homeDest + local;
    let waypoint = destination;
    if (stage === 0) {
      let nearest = Infinity;
      waypoint = -1;
      for (let h = 0; h < this.spec.homes.length; h++) {
        if (h === local || h === this.household[p]) continue;
        const candidate = this.homeDest + h;
        const from = this.spec.homes[h]!.access;
        const k = roads.routing.bestAccess(access, candidate);
        if (k < 0 || roads.routing.bestAccess(from, destination) < 0) continue;
        const cost = roads.routing.timeFrom(candidate, access[k]!.lane, access[k]!.s);
        if (cost < nearest) { nearest = cost; waypoint = candidate; }
      }
      if (waypoint < 0) return false;
    }
    const k = roads.routing.bestAccess(access, waypoint);
    if (k < 0) return false;
    if (roads.trySpawnAt(access[k]!.lane, access[k]!.s, waypoint, p, this.carModelOf(p))) {
      this.activity[p] = OUTBOUND;
      this.origin[p] = waypoint;
      this.circled[p]++;
    }
    return true;
  }

  private startDrive(p: number, roads: TownRoads, minute: number): void {
    const place = this.at[p]!;
    const local = place - this.spec.regions.length;
    const access = this.originAccess(p);
    let dest = this.destination(place);
    this.target[p] = -1;
    if (local >= 0) {
      const bay = this.parking.nearest(local, this.door[local]!, false, this.open, access, roads.routing, this.errand[p] === SHOP ? WALK_CHOICE.groceryParkingRange : WALK_LIMIT);
      if (bay >= 0) { this.target[p] = bay; dest = this.parking.firstDest + bay; }
      else if (this.activity[p] === SEARCH) {
        if (this.circleBlock(p, local, access, roads)) return;
        this.failed[p] = 1;
        this.denied[local]++;
        this.turnedAway++;
        this.frustration[this.household[p]!] = 2;
        this.record(minute, this.household[p]!, PARKING_FAILED, this.errand[p]!, p, this.placeName(place));
        this.due[p] = 0;
        this.activity[p] = RETURN_FAILED;
        return;
      }
    }
    const bay = this.parking.bays[this.target[p]!];
    if (bay && sameEntrance(access, bay.access)) {
      this.activity[p] = OUTBOUND;
      this.arrived(p, minute);
      return;
    }
    const k = roads.routing.bestAccess(access, dest);
    if (k < 0 || !roads.trySpawnAt(access[k]!.lane, access[k]!.s, dest, p, this.carModelOf(p))) return;
    this.assign(this.driverCar[p]!, -1);
    this.activity[p] = OUTBOUND;
  }

  private leaveRegion(p: number, roads: TownRoads, minute: number): void {
    const h = this.household[p]!;
    const place = this.at[p]!;
    const car = this.driverCar[p]!;
    const b = this.parking.bays[this.carBay[car]!];
    const reparking = this.activity[p] === SEEK_HOME;
    const access = this.failed[p] || reparking ? this.originAccess(p) : b?.access ?? this.outside[place] ?? this.spec.homes[place - this.spec.regions.length]!.access;
    const bay = this.parking.nearest(h, this.door[h]!, true, this.open, access, roads.routing);
    const dest = bay < 0 ? this.homeDest + h : this.parking.firstDest + bay;
    const k = roads.routing.bestAccess(access, dest);
    const entrance = this.parking.bays[bay]?.access ?? this.spec.homes[h]!.access;
    const here = sameEntrance(access, entrance);
    if (!here && (k < 0 || !roads.trySpawnAt(access[k]!.lane, access[k]!.s, dest, p, this.carModelOf(p)))) return;
    this.target[p] = bay;
    this.assign(car, -1);
    this.activity[p] = HOMEBOUND;
    if (here) this.arrived(p, minute);
    if (this.errand[p] !== WORK || this.failed[p] || reparking) return;
    this.payWork(p);
  }

  private payWork(p: number): void {
    if (this.errand[p] !== WORK) return;
    const h = this.household[p]!, place = this.at[p]!;
    const start = this.until[p]! - (SHIFT_END - SHIFT_START);
    const hours = Math.max(0, this.until[p]! - Math.max(this.arrivedAt[p]!, start)) / 60;
    const pay = hours * this.wage(place);
    this.funds[h] += pay;
    this.wages[h] += pay;
    this.taxable[h] += pay;
    const employer = place - this.spec.regions.length;
    if (employer >= 0) this.payroll[employer] += pay;
  }

  private buyGroceries(h: number, region: number): void {
    const price = (this.spec.regions[region]?.groceryPrice ?? ECONOMY.localGroceryPrice) * this.memberCount[h]!;
    const days = Math.min(PANTRY_FULL - this.pantry[h]!, Math.max(0, this.funds[h]!) / price);
    this.pantry[h] += days;
    const bill = days * price;
    this.funds[h] -= bill;
    if (region >= this.spec.regions.length) this.taxable[region - this.spec.regions.length] += bill;
  }

  private freeCars(h: number): number {
    let out = 0;
    for (let p = this.firstMember[h]!; p < this.firstMember[h]! + this.memberCount[h]!; p++) {
      if (this.driverCar[p]! >= 0) out++;
    }
    return this.cars[h]! - out;
  }

  private shopping(h: number): boolean {
    for (let p = this.firstMember[h]!; p < this.firstMember[h]! + this.memberCount[h]!; p++) {
      if (this.activity[p] !== HOME && this.errand[p] === SHOP) return true;
    }
    return false;
  }

  /** Free-flow minutes from home `h` to region `r` (Infinity when unreachable). */
  private outTime(h: number, r: number, routing: Routing): number {
    const walking = this.walkTime(h, r);
    if (!this.cars[h]) return walking;
    const access = this.spec.homes[h]!.access;
    const dest = this.destination(r);
    const k = routing.bestAccess(access, dest);
    return k < 0 ? walking : routing.timeFrom(dest, access[k]!.lane, access[k]!.s);
  }

  private walkTime(h: number, r: number): number {
    const length = this.walkers.graph.distance(h, r - this.spec.regions.length);
    return length <= this.walkLimit * (this.cars[h] ? 1 : WALK_CHOICE.carFreeRange) ? length / 1.35 : Infinity;
  }

  private roundTrip(h: number, r: number, routing: Routing): number {
    const walk = 2 * this.walkTime(h, r);
    if (!this.cars[h]) return walk;
    const region = this.spec.regions[r];
    const dest = this.homeDest + h;
    if (region) return this.outTime(h, r, routing) + routing.timeFrom(dest, region.source, 0);
    const access = this.spec.homes[r - this.spec.regions.length]!.access;
    const k = routing.bestAccess(access, dest);
    return k < 0 ? walk : this.outTime(h, r, routing) + routing.timeFrom(dest, access[k]!.lane, access[k]!.s);
  }

  private nearestShop(h: number, routing: Routing): number {
    let best = -1;
    let bestTime = Infinity;
    for (let b = 0; b < this.open.length; b++) {
      if (!this.open[b] || lotZone(this.spec.homes[b]!.lot!) !== 'shops') continue;
      const r = this.spec.regions.length + b;
      const time = this.roundTrip(h, r, routing);
      if (time < bestTime) { best = r; bestTime = time; }
    }
    if (best >= 0) return best;
    for (let r = 0; r < this.spec.regions.length; r++) {
      const t = this.roundTrip(h, r, routing);
      if (t < bestTime) {
        best = r;
        bestTime = t;
      }
    }
    return best;
  }

  // --- Days ---------------------------------------------------------------------

  private dailyTax(h: number): number {
    if (this.level[h]) return Math.round(this.taxable[h]! * BUDGET.homeTax);
    const lot = this.spec.homes[h]!.lot!;
    if (lotZone(lot) === 'shops') {
      return Math.round(this.taxable[h]! * BUDGET.shopTax + lot.columns * lot.rows * BUDGET.shopRatePerCell);
    }
    return Math.round(this.payroll[h]! * BUDGET.workplaceTax);
  }

  private midnight(minute: number, routing: Routing): void {
    this.deliveries.fill(0);
    this.customers.fill(0);
    this.denied.fill(0);
    for (let h = 0; h < this.frustration.length; h++) if (this.frustration[h]) this.frustration[h]--;
    for (let h = 0; h < this.spec.homes.length; h++) {
      if (!this.open[h] && !this.level[h]) continue;
      const tax = this.dailyTax(h);
      this.taxable[h] = 0;
      if (this.open[h]) {
        const shop = lotZone(this.spec.homes[h]!.lot!) === 'shops';
        this.lastDailyCost[h] = this.payroll[h]! + tax;
        this.payroll[h] = 0;
        this.treasury.today[shop ? 'shops' : 'workplaces'] += tax;
        this.taxesPaid[h] += tax;
      }
      if (!this.level[h]) continue;
      this.treasury.today.homes += tax;
      this.funds[h] -= this.dailyCost(h) + tax;
      this.pantry[h] = Math.max(0, this.pantry[h]! - 1);
    }
    this.treasury.close(this.spec.roadMetres, this.dailyRoadUpkeep);
    this.jobMarket(routing, minute);
    for (let h = 0; h < this.spec.homes.length; h++) if (this.level[h]) this.purchase(h, minute);
    for (let p = 0; p < this.people; p++) if (!this.departed(p)) this.early[p] = this.rng.int(MAX_EARLY);
  }

  private dailyCost(h: number): number {
    const adults = this.adults[h]!;
    return adults * ECONOMY.adultCost + (this.memberCount[h]! - adults) * ECONOMY.childCost
      + ECONOMY.houseUpkeep[this.level[h]!]! + this.cars[h]! * ECONOMY.carUpkeep;
  }

  /** Daily value of working in region `r` for household `h`: pay minus the time spent commuting. */
  private jobValue(h: number, r: number, routing: Routing): number {
    return this.wage(r) * (SHIFT_END - SHIFT_START) / 60 - ECONOMY.commuteValuePerMinute * this.roundTrip(h, r, routing);
  }

  private jobMarket(routing: Routing, minute: number): void {
    const { regions } = this.spec;
    this.filled.fill(0);
    for (let p = 0; p < this.people; p++) {
      const job = this.job[p]!;
      if (job < 0) continue;
      if (this.roundTrip(this.household[p]!, job, routing) < Infinity) {
        this.filled[job]++;
        continue;
      }
      this.job[p] = -1;
      this.record(minute, this.household[p]!, LOST_JOB, job, p);
    }
    // Make the single most valuable hire or switch until none is left, so a job goes to
    // whoever gains most from it (locals before long-distance commuters). Every move raises
    // that person's job value, so this ends.
    for (;;) {
      let person = -1;
      let region = -1;
      let bestGain = 0;
      for (let p = 0; p < this.people; p++) {
        if (this.role[p] !== ADULT) continue;
        const h = this.household[p]!;
        const current = this.job[p]!;
        if (current < 0 && this.employed(h) >= this.cars[h]!) continue;
        const base = current >= 0 ? this.jobValue(h, current, routing) + ECONOMY.switchMargin : 0;
        for (let r = 0; r < this.filled.length; r++) {
          const slot = r - regions.length;
          const jobs = regions[r]?.jobs ?? (this.open[slot] ? lotJobs(this.spec.homes[slot]!.lot!) : 0);
          if (r === current || this.filled[r]! >= jobs) continue;
          const gain = this.jobValue(h, r, routing) - base;
          if (gain > bestGain) {
            person = p;
            region = r;
            bestGain = gain;
          }
        }
      }
      if (person < 0) return;
      const current = this.job[person]!;
      if (current >= 0) this.filled[current]--;
      this.filled[region]++;
      this.job[person] = region;
      this.record(minute, this.household[person]!, current < 0 ? NEW_JOB : CHANGED_JOB, region, person);
    }
  }

  private employed(h: number): number {
    let n = 0;
    for (let p = this.firstMember[h]!; p < this.firstMember[h]! + this.memberCount[h]!; p++) {
      if (this.job[p]! >= 0) n++;
    }
    return n;
  }

  /** At most one purchase a day, for the household's worst unmet need, keeping a cash reserve. */
  private purchase(h: number, minute: number): void {
    const spare = this.funds[h]! - ECONOMY.reserveDays * this.dailyCost(h);
    const mobility = this.mobility(h);
    const comfort = this.comfort(h);
    const level = this.level[h]!;
    const model = this.carModel[h]!;
    if (mobility < 1 && mobility <= comfort) {
      if (spare >= ECONOMY.carPrice[model]!) this.buyCar(h, minute, spare);
      return;
    }
    if (comfort < 1) {
      if (level < MAX_LEVEL && spare >= ECONOMY.housePrice[level + 1]!) this.upgradeHouse(h, minute);
      return;
    }
    const house = level < MAX_LEVEL ? ECONOMY.housePrice[level + 1]! : Infinity;
    const car = model < MAX_MODEL ? this.cars[h]! * (ECONOMY.carPrice[model + 1]! - ECONOMY.carPrice[model]! * ECONOMY.tradeInShare) : Infinity;
    if (Math.min(house, car) === Infinity || spare < Math.min(house, car) + ECONOMY.wealthMargin) return;
    if (house <= car) this.upgradeHouse(h, minute);
    else {
      this.funds[h] -= car;
      this.carModel[h] = model + 1;
      this.carUpgrades++;
      this.record(minute, h, NEWER_CAR, model + 1);
    }
  }

  private buyCar(h: number, minute: number, spare: number): void {
    const current = this.carModel[h]!;
    const children = this.memberCount[h]! - this.adults[h]!;
    const preferred = children ? Model.Estate : Model.SUV;
    const price = ECONOMY.carPrice[preferred];
    const trade = this.cars[h]! * (price - ECONOMY.carPrice[current]! * ECONOMY.tradeInShare);
    if (current < preferred && spare >= price + trade + ECONOMY.wealthMargin) {
      this.carModel[h] = preferred;
      this.funds[h] -= trade;
      this.carUpgrades++;
      this.record(minute, h, NEWER_CAR, preferred);
    }
    this.funds[h] -= ECONOMY.carPrice[this.carModel[h]!]!;
    this.parkAtHome(h * 2 + this.cars[h]!);
    this.cars[h]++;
    this.carsBought++;
    this.record(minute, h, BOUGHT_CAR, this.cars[h]!);
  }

  private upgradeHouse(h: number, minute: number): void {
    this.funds[h] -= ECONOMY.housePrice[this.level[h]! + 1]!;
    this.level[h]++;
    this.houseUpgrades++;
    this.record(minute, h, UPGRADED_HOUSE, this.level[h]!);
  }

  private record(minute: number, h: number, kind: number, detail: number, person = -1, place?: string): void {
    const i = (this.eventHead + this.eventCount) % EVENT_CAPACITY;
    this.eventDay[i] = dayOf(minute);
    this.eventMinute[i] = minute % MINUTES_PER_DAY;
    this.eventHousehold[i] = h;
    this.eventKind[i] = kind;
    this.eventDetail[i] = detail;
    this.eventPerson[i] = person;
    if (person >= 0) this.eventPlace[i] = place ?? this.placeName(detail);
    if (this.eventCount < EVENT_CAPACITY) this.eventCount++;
    else this.eventHead = (this.eventHead + 1) % EVENT_CAPACITY;
  }

  // --- Needs --------------------------------------------------------------------

  private food(h: number): number {
    return clamp01(this.pantry[h]! / 2);
  }

  private comfort(h: number): number {
    return clamp01(HOUSE_CAPACITY[this.level[h]!]! / this.memberCount[h]!);
  }

  private mobility(h: number): number {
    return clamp01(this.cars[h]! / this.adults[h]!);
  }

  private security(h: number): number {
    return clamp01(this.funds[h]! / (ECONOMY.reserveDays * this.dailyCost(h)));
  }

  // --- Output -------------------------------------------------------------------

  /** Model of the cars in person `p`'s household (1 = oldest). */
  carModelOf(p: number): number {
    return this.carModel[this.household[p]!]!;
  }

  hash(mix: (x: number) => void): void {
    this.treasury.hash(mix);
    this.taxable.forEach(n => mix(Math.round(n * 100)));
    this.taxesPaid.forEach(mix);
    this.payroll.forEach(n => mix(Math.round(n * 100)));
    this.lastDailyCost.forEach(n => mix(Math.round(n * 100)));
    for (let h = 0; h < this.spec.homes.length; h++) {
      const lot = this.spec.homes[h]!.lot;
      if (lot) { mix(lot.key); mix(lot.columns); mix(lot.rows); }
      if (!this.level[h]) continue;
      mix(Math.round(this.funds[h]! * 100));
      mix(Math.round(this.pantry[h]! * 1e4));
      mix(this.level[h]! | (this.cars[h]! << 8) | (this.carModel[h]! << 16));
    }
    for (let p = 0; p < this.people; p++) {
      if (this.departed(p)) continue;
      mix(this.job[p]! + 1 | (this.activity[p]! << 8) | (this.errand[p]! << 16) | ((this.at[p]! + 1) << 24));
      mix(this.until[p]!);
      mix(this.workedDay[p]!);
      mix(this.early[p]!);
      mix(this.modeDay[p]!);
      mix(Math.round(this.modeRoll[p]!*0xffffffff));
    }
    for (const zone of ZONE_KINDS) if (this.growth[zone]) mix(this.growth[zone]);
    for (let h = 0; h < this.open.length; h++) {
      const lot = this.spec.homes[h]!.lot;
      if (!lot || lotZone(lot) === 'residential') continue;
      mix(lotZone(lot) === 'shops' ? 1 : 2);
      mix(this.open[h]!);
      mix(this.deliveries[h]!);
      mix(this.freightState[h]!);
      mix(this.freightDue[h]!);
      mix(this.customers[h]!);
    }
    this.parking.occupant.forEach(mix);
    this.driverCar.forEach(mix);
    this.due.forEach(mix);
    this.target.forEach(mix);
    this.origin.forEach(mix);
    this.failed.forEach(mix);
    this.circled.forEach(mix);
    this.frustration.forEach(mix);
    this.denied.forEach(mix);
    this.walkers.goal.forEach(mix);
    for (let p=0; p<this.people; p++) if (this.walkers.goal[p]! >= 0) { mix(this.walkers.node[p]!); mix(Math.round(this.walkers.along[p]!*1000)); }
    mix(this.walkedTrips);
    mix(this.trips);
    mix(this.parked);
    mix(this.turnedAway);
    mix(Math.round(this.walkMetres * 100));
    mix(this.carsBought);
    mix(this.houseUpgrades);
    mix(this.carUpgrades);
  }

  /** A readable copy of the town at absolute `minute`. Allocates; not for the tick loop. */
  view(minute: number): TownView {
    const { regions, homes } = this.spec;
    const regionName = (r: number): string | null => (r >= 0 ? this.placeName(r) : null);
    const households: HouseholdView[] = [];
    let adults = 0;
    let employed = 0;
    let cars = 0;
    let crossCommuters = 0;
    let localWorkers = 0;
    let funds = 0;
    for (let h = 0; h < homes.length; h++) {
      if (!this.level[h]) continue;
      const members: PersonView[] = [];
      for (let p = this.firstMember[h]!; p < this.firstMember[h]! + this.memberCount[h]!; p++) {
        const adult = this.role[p] === ADULT;
        const job = this.job[p]!;
        const home = this.activity[p] === HOME;
        members.push({
          id: p,
          firstName: FIRST_NAMES[this.firstName[p]!]!,
          role: adult ? 'adult' : 'child',
          age: this.age[p]!,
          job: regionName(job),
          activity: ACTIVITIES[this.activity[p]!]!,
          leg: this.driving(p) ? 'drive' : ACTIVITIES[this.activity[p]!] === 'walking' ? 'walk' : ACTIVITIES[this.activity[p]!] === 'searching' ? 'park' : null,
          errand: home ? null : ERRANDS[this.errand[p]!]!,
          place: home ? null : regionName(this.at[p]!),
        });
        if (adult) adults++;
        if (job >= 0) {
          employed++;
          const local = job >= regions.length;
          if (local) localWorkers++;
          const region = local ? homes[job - regions.length]!.region : job;
          if (region !== homes[h]!.region) crossCommuters++;
        }
      }
      const needs: Needs = { food: this.food(h), comfort: this.comfort(h), mobility: this.mobility(h), security: this.security(h) };
      cars += this.cars[h]!;
      funds += this.funds[h]!;
      const parcel = homes[h]!.lot;
      households.push({
        id: h,
        home: h,
        ...(parcel ? { lot: visibleLot(parcel, this.level[h]!) } : {}),
        region: regions[homes[h]!.region]!.name,
        surname: SURNAMES[this.surname[h]!]!,
        level: this.level[h]!,
        cars: this.cars[h]!,
        drivewayOverflow: Array.from(this.carBay.subarray(h * 2, h * 2 + this.cars[h]!)).filter((b, i) => b < 0 && !members.some(m => this.driverCar[m.id] === h * 2 + i)).length,
        parked: Array.from({ length: this.cars[h]! }, (_, i) => {
          const bay = this.parking.bays[this.carBay[h * 2 + i]!];
          return bay?.kind ?? (members.some(m => this.driverCar[m.id] === h * 2 + i) ? 'away' : 'apron (overflow)');
        }),
        carModel: this.carModel[h]!,
        funds: this.funds[h]!,
        wages: this.wages[h]!,
        pantry: this.pantry[h]!,
        needs,
        walkIssue: this.walkIssue[h]! >= 0 && this.spec.homes[this.walkIssue[h]! - this.spec.regions.length]?.lot ? this.placeName(this.walkIssue[h]!) : undefined,
        happiness: Math.max(0, (needs.food + needs.comfort + needs.mobility + needs.security) / 4 - this.frustration[h]! * 0.04),
        members,
      });
    }
    const events: TownEventView[] = [];
    for (let k = 0; k < this.eventCount; k++) {
      const i = (this.eventHead + k) % EVENT_CAPACITY;
      if (this.eventHousehold[i]! < 0) continue;
      const at = { day: this.eventDay[i]!, minute: this.eventMinute[i]!, household: this.eventHousehold[i]! };
      const detail = this.eventDetail[i]!;
      const person = this.eventPerson[i]!;
      switch (this.eventKind[i]) {
        case NO_WALK_ROUTE: events.push({ ...at, kind: 'noWalkRoute', region: this.eventPlace[i]! }); break;
        case PARKING_FAILED: events.push({ ...at, kind: 'parkingFailed', shopper: detail === SHOP, region: this.eventPlace[i]! }); break;
        case MOVED_IN: events.push({ ...at, kind: 'movedIn' }); break;
        case BOUGHT_CAR: events.push({ ...at, kind: 'boughtCar', cars: detail }); break;
        case NEWER_CAR: events.push({ ...at, kind: 'newerCar', model: detail }); break;
        case UPGRADED_HOUSE: events.push({ ...at, kind: 'upgradedHouse', level: detail }); break;
        case NEW_JOB: events.push({ ...at, kind: 'newJob', region: this.eventPlace[i]!, person }); break;
        case CHANGED_JOB: events.push({ ...at, kind: 'changedJob', region: this.eventPlace[i]!, person }); break;
        case LOST_JOB: events.push({ ...at, kind: 'lostJob', region: this.eventPlace[i]!, person }); break;
      }
    }
    const budget = this.treasury.view();
    budget.today.upkeep = this.dailyRoadUpkeep;
    for (const household of households) budget.today.homes += this.dailyTax(household.home);
    const businesses: BusinessView[] = [];
    for (let h = 0; h < homes.length; h++) {
      if (!this.open[h]) continue;
      const lot = homes[h]!.lot!;
      const r = h + regions.length;
      const zone = lotZone(lot);
      if (zone === 'residential') throw new Error('A residence cannot be an open business');
      budget.today[zone] += this.dailyTax(h);
      const loadingBay = this.loadingPose[h]!;
      // Leave room for a lorry using the shared entrance while the next driver waits.
      const clearance = vehicleType(Model.Lorry).length + 1;
      const kerb = { x: loadingBay.x - Math.cos(loadingBay.angle) * clearance,
        y: loadingBay.y - Math.sin(loadingBay.angle) * clearance, angle: loadingBay.angle };
      businesses.push({ lastDailyCost: this.lastDailyCost[h]!, taxesPaid: this.taxesPaid[h]!, home: h, lot: visibleLot(lot), name: this.placeName(r), zone,
        deliveries: this.deliveries[h]!, unloading: this.freightState[h] === UNLOADING, waitingAtKerb: this.freightState[h] === WAIT_KERB, loadingBay, kerb,
        occupied: this.parking.bays.filter((b, i) => b.home === h && this.parking.occupant[i]! >= 0).length,
        capacity: this.parking.bays.filter(b => b.home === h).length, turnedAway: this.denied[h]!,
        jobs: lotJobs(lot), filled: this.filled[r]!, customers: this.customers[h]! });
    }
    return {
      overflowCars: households.flatMap(h => {
        if (!h.drivewayOverflow) return [];
        const drive = this.parking.bays.find(b => b.home === h.home && b.kind === 'driveway');
        if (!drive) return [];
        return [{ x: drive.x + Math.cos(drive.angle) * 4.9, y: drive.y + Math.sin(drive.angle) * 4.9, angle: drive.angle, model: h.carModel }];
      }),
      bays: this.parking.bays.flatMap((b, i) => {
        if (b.home >= 0 && !this.open[b.home] && !this.level[b.home]) return [];
        const car = this.parking.occupant[i]!;
        return [{ x: b.x, y: b.y, angle: b.angle, kind: b.kind, model: car < 0 ? 0 : this.carModel[Math.floor(car / 2)]! }];
      }),
      parking: { walkedTrips: this.walkedTrips, peakWalkers: this.walkers.peak, trips: this.trips, parked: this.parked, turnedAway: this.turnedAway, walkMetres: this.walkMetres },
      budget,
      businesses,
      demand: { residential: this.demandFor('residential'), shops: this.demandFor('shops'), workplaces: this.demandFor('workplaces') },
      day: dayOf(minute),
      minuteOfDay: minute % MINUTES_PER_DAY,
      totals: {
        population: households.reduce((n, h) => n + h.members.length, 0),
        adults,
        employed,
        cars,
        carsBought: this.carsBought,
        houseUpgrades: this.houseUpgrades,
        carUpgrades: this.carUpgrades,
        meanFunds: households.length > 0 ? funds / households.length : 0,
        crossCommuters,
        localWorkers,
      },
      households,
      events,
    };
  }
}
