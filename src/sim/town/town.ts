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
  trySpawnAt(lane: number, s: number, dest: number, owner: number): boolean;
}

// Person activity: Home -> Outbound(errand) -> Away(errand) -> Homebound -> Home.
// A person is Outbound or Homebound exactly while one live vehicle has them as owner.
const HOME = 0;
const OUTBOUND = 1;
const AWAY = 2;
const HOMEBOUND = 3;
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

const ADULT_COST = 30;
const CHILD_COST = 20;
const CAR_UPKEEP = 8;
/** Indexed by house level (1..3). */
const HOUSE_UPKEEP = [0, 10, 18, 30];
const HOUSE_CAPACITY = [0, 3, 5, 7];
const HOUSE_PRICE = [0, 0, 1800, 4000];
const MAX_LEVEL = 3;
/** Indexed by car model (1..3). A newer model trades the old cars in at half price. */
const CAR_PRICE = [0, 1200, 2200, 3600];
const MAX_MODEL = 3;
/** Purchases keep this many days of running costs in the bank. */
const RESERVE_DAYS = 7;
/** Luxuries (bigger house, newer car) wait until this much is spare on top of the price. */
const WEALTH_MARGIN = 800;
/** How much an hour of driving is worth when choosing a job, per minute of round trip. */
const COMMUTE_VALUE = 0.5;
/** A better job has to beat the current one by this much per day to be worth switching. */
const SWITCH_MARGIN = 10;
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

export type Activity = 'home' | 'outbound' | 'away' | 'homebound';
export type Errand = 'work' | 'shop';
const ACTIVITIES: readonly Activity[] = ['home', 'outbound', 'away', 'homebound'];
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
  /** Why they are out; null at home. */
  errand: Errand | null;
  /** Region they are driving to, staying in or coming back from; null at home. */
  place: string | null;
}

export interface HouseholdView {
  id: number;
  /** Index into `scenario.decor.houses`. */
  home: number;
  /** The region this neighbourhood belongs to. */
  region: string;
  surname: string;
  level: number;
  cars: number;
  carModel: number;
  funds: number;
  /** All wages earned since the start. */
  wages: number;
  /** Days of food left. */
  pantry: number;
  needs: Needs;
  /** Mean of the needs. */
  happiness: number;
  members: PersonView[];
}

export type TownEventView = { day: number; minute: number; household: number } & (
  | { kind: 'boughtCar'; cars: number }
  | { kind: 'newerCar'; model: number }
  | { kind: 'upgradedHouse'; level: number }
  | { kind: 'newJob' | 'changedJob' | 'lostJob'; region: string }
);

export interface TownView {
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
  /** Region index, or -1 when unemployed. */
  private readonly job: Int8Array;
  private readonly activity: Uint8Array;
  private readonly errand: Uint8Array;
  /** Region of the current trip. */
  private readonly at: Int8Array;
  /** Absolute minute they arrived in the region. */
  private readonly arrivedAt: Int32Array;
  /** Absolute minute they want to head home. */
  private readonly until: Int32Array;
  private readonly workedDay: Int32Array;
  /** Today's minutes of slack on the morning commute. */
  private readonly early: Uint8Array;

  private readonly filled: Int32Array;
  private carsBought = 0;
  private houseUpgrades = 0;
  private carUpgrades = 0;

  private readonly eventDay: Int32Array;
  private readonly eventMinute: Int16Array;
  private readonly eventHousehold: Int16Array;
  private readonly eventKind: Uint8Array;
  private readonly eventDetail: Int16Array;
  private eventHead = 0;
  private eventCount = 0;

  constructor(spec: TownSpec, homeDest: number, seed: number, routing: Routing) {
    this.spec = spec;
    this.homeDest = homeDest;
    this.rng = new Rng((seed ^ TOWN_SEED) >>> 0);
    const H = spec.homes.length;
    const P = H * MAX_MEMBERS;
    this.surname = new Uint16Array(H);
    this.funds = new Float64Array(H);
    this.wages = new Float64Array(H);
    this.level = new Uint8Array(H);
    this.cars = new Uint8Array(H);
    this.carModel = new Uint8Array(H);
    this.pantry = new Float64Array(H);
    this.firstMember = new Int32Array(H);
    this.memberCount = new Uint8Array(H);
    this.adults = new Uint8Array(H);
    this.household = new Int32Array(P);
    this.role = new Uint8Array(P);
    this.age = new Uint8Array(P);
    this.firstName = new Uint16Array(P);
    this.job = new Int8Array(P).fill(-1);
    this.activity = new Uint8Array(P);
    this.errand = new Uint8Array(P);
    this.at = new Int8Array(P).fill(-1);
    this.arrivedAt = new Int32Array(P);
    this.until = new Int32Array(P);
    this.workedDay = new Int32Array(P);
    this.early = new Uint8Array(P);
    this.filled = new Int32Array(spec.regions.length);
    this.eventDay = new Int32Array(EVENT_CAPACITY);
    this.eventMinute = new Int16Array(EVENT_CAPACITY);
    this.eventHousehold = new Int16Array(EVENT_CAPACITY);
    this.eventKind = new Uint8Array(EVENT_CAPACITY);
    this.eventDetail = new Int16Array(EVENT_CAPACITY);

    const rng = this.rng;
    for (let h = 0; h < H; h++) {
      this.surname[h] = rng.int(SURNAMES.length);
      const adults = rng.next() < 0.6 ? 2 : 1;
      const children = rng.int(4);
      this.firstMember[h] = this.people;
      this.memberCount[h] = adults + children;
      this.adults[h] = adults;
      for (let k = 0; k < adults + children; k++) {
        const p = this.people++;
        this.household[p] = h;
        this.role[p] = k < adults ? ADULT : 1;
        this.age[p] = k < adults ? 24 + rng.int(36) : rng.int(18);
        this.firstName[p] = rng.int(FIRST_NAMES.length);
        this.early[p] = rng.int(MAX_EARLY);
      }
      this.funds[h] = 1000 + rng.int(1500);
      this.level[h] = 1;
      this.cars[h] = 1;
      this.carModel[h] = 1;
      this.pantry[h] = 2 + rng.next() * 2;
    }
    this.jobMarket(routing, CLOCK_START);
  }

  /** Continue exactly this town's state (same homes) in another world. */
  copyFrom(source: Town): void {
    if (source.spec.homes.length !== this.spec.homes.length || source.filled.length !== this.filled.length) {
      throw new Error('Towns must have the same homes and regions');
    }
    this.rng.copyFrom(source.rng);
    for (const key of [
      'surname', 'funds', 'wages', 'level', 'cars', 'carModel', 'pantry', 'firstMember', 'memberCount', 'adults',
      'household', 'role', 'age', 'firstName', 'job', 'activity', 'errand', 'at', 'arrivedAt', 'until', 'workedDay',
      'early', 'eventDay', 'eventMinute', 'eventHousehold', 'eventKind', 'eventDetail',
    ] as const) this[key].set(source[key]);
    this.people = source.people;
    this.carsBought = source.carsBought;
    this.houseUpgrades = source.houseUpgrades;
    this.carUpgrades = source.carUpgrades;
    this.eventHead = source.eventHead;
    this.eventCount = source.eventCount;
  }

  /** Advance one game minute. `minute` counts from midnight before day 1. */
  update(minute: number, roads: TownRoads): void {
    const clock = minute % MINUTES_PER_DAY;
    if (clock === 0) this.midnight(minute, roads.routing);
    const day = dayOf(minute);
    for (let p = 0; p < this.people; p++) {
      if (this.role[p] !== ADULT) continue;
      if (this.activity[p] === HOME) this.leaveHome(p, day, clock, roads);
      else if (this.activity[p] === AWAY && minute >= this.until[p]!) this.leaveRegion(p, roads);
    }
  }

  /** A resident's car reached its destination. */
  arrived(p: number, minute: number): void {
    if (this.activity[p] === OUTBOUND) {
      this.activity[p] = AWAY;
      this.arrivedAt[p] = minute;
      this.until[p] = this.errand[p] === WORK
        ? (this.workedDay[p]! - 1) * MINUTES_PER_DAY + SHIFT_END
        : minute + SHOP_STAY;
    } else if (this.activity[p] === HOMEBOUND) {
      this.activity[p] = HOME;
      if (this.errand[p] === SHOP) this.buyGroceries(this.household[p]!, this.at[p]!);
    }
  }

  /** A resident's car was removed without arriving: the trip is abandoned at home. */
  lost(p: number): void {
    this.activity[p] = HOME;
  }

  // --- Trips --------------------------------------------------------------------

  private leaveHome(p: number, day: number, clock: number, roads: TownRoads): void {
    const h = this.household[p]!;
    if (this.freeCars(h) === 0) return;
    const job = this.job[p]!;
    if (job >= 0 && this.workedDay[p] !== day) {
      const travel = this.outTime(h, job, roads.routing);
      if (clock >= SHIFT_START - travel - this.early[p]! && clock + travel <= SHIFT_END - MIN_SHIFT) {
        if (this.depart(p, WORK, job, roads)) this.workedDay[p] = day;
        return;
      }
    }
    if (clock < SHOP_OPENS || clock >= SHOP_CLOSES || this.pantry[h]! >= PANTRY_LOW || this.shopping(h)) return;
    const shop = this.nearestShop(h, roads.routing);
    if (shop >= 0) this.depart(p, SHOP, shop, roads);
  }

  private depart(p: number, errand: number, region: number, roads: TownRoads): boolean {
    const access = this.spec.homes[this.household[p]!]!.access;
    const dest = this.spec.regions[region]!.sink;
    const k = roads.routing.bestAccess(access, dest);
    if (k < 0 || !roads.trySpawnAt(access[k]!.lane, access[k]!.s, dest, p)) return false;
    this.activity[p] = OUTBOUND;
    this.errand[p] = errand;
    this.at[p] = region;
    return true;
  }

  private leaveRegion(p: number, roads: TownRoads): void {
    const h = this.household[p]!;
    const region = this.spec.regions[this.at[p]!]!;
    if (!roads.trySpawnAt(region.source, 0, this.homeDest + h, p)) return;
    this.activity[p] = HOMEBOUND;
    if (this.errand[p] !== WORK) return;
    const start = this.until[p]! - (SHIFT_END - SHIFT_START);
    const hours = Math.max(0, this.until[p]! - Math.max(this.arrivedAt[p]!, start)) / 60;
    this.funds[h] += hours * region.wage;
    this.wages[h] += hours * region.wage;
  }

  private buyGroceries(h: number, region: number): void {
    const price = this.spec.regions[region]!.groceryPrice * this.memberCount[h]!;
    const days = Math.min(PANTRY_FULL - this.pantry[h]!, Math.max(0, this.funds[h]!) / price);
    this.pantry[h] += days;
    this.funds[h] -= days * price;
  }

  private freeCars(h: number): number {
    let out = 0;
    for (let p = this.firstMember[h]!; p < this.firstMember[h]! + this.memberCount[h]!; p++) {
      if (this.activity[p] !== HOME) out++;
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
    const access = this.spec.homes[h]!.access;
    const dest = this.spec.regions[r]!.sink;
    const k = routing.bestAccess(access, dest);
    return k < 0 ? Infinity : routing.timeFrom(dest, access[k]!.lane, access[k]!.s);
  }

  private roundTrip(h: number, r: number, routing: Routing): number {
    return this.outTime(h, r, routing) + routing.timeFrom(this.homeDest + h, this.spec.regions[r]!.source, 0);
  }

  private nearestShop(h: number, routing: Routing): number {
    let best = -1;
    let bestTime = Infinity;
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

  private midnight(minute: number, routing: Routing): void {
    for (let h = 0; h < this.spec.homes.length; h++) {
      this.funds[h] -= this.dailyCost(h);
      this.pantry[h] = Math.max(0, this.pantry[h]! - 1);
    }
    this.jobMarket(routing, minute);
    for (let h = 0; h < this.spec.homes.length; h++) this.purchase(h, minute);
    for (let p = 0; p < this.people; p++) this.early[p] = this.rng.int(MAX_EARLY);
  }

  private dailyCost(h: number): number {
    const adults = this.adults[h]!;
    return adults * ADULT_COST + (this.memberCount[h]! - adults) * CHILD_COST
      + HOUSE_UPKEEP[this.level[h]!]! + this.cars[h]! * CAR_UPKEEP;
  }

  /** Daily value of working in region `r` for household `h`: pay minus the time spent commuting. */
  private jobValue(h: number, r: number, routing: Routing): number {
    const region = this.spec.regions[r]!;
    return region.wage * (SHIFT_END - SHIFT_START) / 60 - COMMUTE_VALUE * this.roundTrip(h, r, routing);
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
      this.record(minute, this.household[p]!, LOST_JOB, job);
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
        const base = current >= 0 ? this.jobValue(h, current, routing) + SWITCH_MARGIN : 0;
        for (let r = 0; r < regions.length; r++) {
          if (r === current || this.filled[r]! >= regions[r]!.jobs) continue;
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
      this.record(minute, this.household[person]!, current < 0 ? NEW_JOB : CHANGED_JOB, region);
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
    const spare = this.funds[h]! - RESERVE_DAYS * this.dailyCost(h);
    const mobility = this.mobility(h);
    const comfort = this.comfort(h);
    const level = this.level[h]!;
    const model = this.carModel[h]!;
    if (mobility < 1 && mobility <= comfort) {
      if (spare >= CAR_PRICE[model]!) this.buyCar(h, minute);
      return;
    }
    if (comfort < 1) {
      if (level < MAX_LEVEL && spare >= HOUSE_PRICE[level + 1]!) this.upgradeHouse(h, minute);
      return;
    }
    const house = level < MAX_LEVEL ? HOUSE_PRICE[level + 1]! : Infinity;
    const car = model < MAX_MODEL ? this.cars[h]! * (CAR_PRICE[model + 1]! - CAR_PRICE[model]! / 2) : Infinity;
    if (Math.min(house, car) === Infinity || spare < Math.min(house, car) + WEALTH_MARGIN) return;
    if (house <= car) this.upgradeHouse(h, minute);
    else {
      this.funds[h] -= car;
      this.carModel[h] = model + 1;
      this.carUpgrades++;
      this.record(minute, h, NEWER_CAR, model + 1);
    }
  }

  private buyCar(h: number, minute: number): void {
    this.funds[h] -= CAR_PRICE[this.carModel[h]!]!;
    this.cars[h]++;
    this.carsBought++;
    this.record(minute, h, BOUGHT_CAR, this.cars[h]!);
  }

  private upgradeHouse(h: number, minute: number): void {
    this.funds[h] -= HOUSE_PRICE[this.level[h]! + 1]!;
    this.level[h]++;
    this.houseUpgrades++;
    this.record(minute, h, UPGRADED_HOUSE, this.level[h]!);
  }

  private record(minute: number, h: number, kind: number, detail: number): void {
    const i = (this.eventHead + this.eventCount) % EVENT_CAPACITY;
    this.eventDay[i] = dayOf(minute);
    this.eventMinute[i] = minute % MINUTES_PER_DAY;
    this.eventHousehold[i] = h;
    this.eventKind[i] = kind;
    this.eventDetail[i] = detail;
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
    return clamp01(this.funds[h]! / (RESERVE_DAYS * this.dailyCost(h)));
  }

  // --- Output -------------------------------------------------------------------

  hash(mix: (x: number) => void): void {
    for (let h = 0; h < this.spec.homes.length; h++) {
      mix(Math.round(this.funds[h]! * 100));
      mix(Math.round(this.pantry[h]! * 1e4));
      mix(this.level[h]! | (this.cars[h]! << 8) | (this.carModel[h]! << 16));
    }
    for (let p = 0; p < this.people; p++) {
      mix(this.job[p]! + 1 | (this.activity[p]! << 8) | (this.errand[p]! << 16) | ((this.at[p]! + 1) << 24));
      mix(this.until[p]!);
      mix(this.workedDay[p]!);
      mix(this.early[p]!);
    }
    mix(this.carsBought);
    mix(this.houseUpgrades);
    mix(this.carUpgrades);
  }

  /** A readable copy of the town at absolute `minute`. Allocates; not for the tick loop. */
  view(minute: number): TownView {
    const { regions, homes } = this.spec;
    const regionName = (r: number): string | null => (r >= 0 ? regions[r]!.name : null);
    const households: HouseholdView[] = [];
    let adults = 0;
    let employed = 0;
    let cars = 0;
    let crossCommuters = 0;
    let funds = 0;
    for (let h = 0; h < homes.length; h++) {
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
          errand: home ? null : ERRANDS[this.errand[p]!]!,
          place: home ? null : regionName(this.at[p]!),
        });
        if (adult) adults++;
        if (job >= 0) employed++;
        if (job >= 0 && job !== homes[h]!.region) crossCommuters++;
      }
      const needs: Needs = { food: this.food(h), comfort: this.comfort(h), mobility: this.mobility(h), security: this.security(h) };
      cars += this.cars[h]!;
      funds += this.funds[h]!;
      households.push({
        id: h,
        home: h,
        region: regions[homes[h]!.region]!.name,
        surname: SURNAMES[this.surname[h]!]!,
        level: this.level[h]!,
        cars: this.cars[h]!,
        carModel: this.carModel[h]!,
        funds: this.funds[h]!,
        wages: this.wages[h]!,
        pantry: this.pantry[h]!,
        needs,
        happiness: (needs.food + needs.comfort + needs.mobility + needs.security) / 4,
        members,
      });
    }
    const events: TownEventView[] = [];
    for (let k = 0; k < this.eventCount; k++) {
      const i = (this.eventHead + k) % EVENT_CAPACITY;
      const at = { day: this.eventDay[i]!, minute: this.eventMinute[i]!, household: this.eventHousehold[i]! };
      const detail = this.eventDetail[i]!;
      switch (this.eventKind[i]) {
        case BOUGHT_CAR: events.push({ ...at, kind: 'boughtCar', cars: detail }); break;
        case NEWER_CAR: events.push({ ...at, kind: 'newerCar', model: detail }); break;
        case UPGRADED_HOUSE: events.push({ ...at, kind: 'upgradedHouse', level: detail }); break;
        case NEW_JOB: events.push({ ...at, kind: 'newJob', region: regions[detail]!.name }); break;
        case CHANGED_JOB: events.push({ ...at, kind: 'changedJob', region: regions[detail]!.name }); break;
        case LOST_JOB: events.push({ ...at, kind: 'lostJob', region: regions[detail]!.name }); break;
      }
    }
    return {
      day: dayOf(minute),
      minuteOfDay: minute % MINUTES_PER_DAY,
      totals: {
        population: this.people,
        adults,
        employed,
        cars,
        carsBought: this.carsBought,
        houseUpgrades: this.houseUpgrades,
        carUpgrades: this.carUpgrades,
        meanFunds: homes.length > 0 ? funds / homes.length : 0,
        crossCommuters,
      },
      households,
      events,
    };
  }
}
