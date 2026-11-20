import { describe, expect, it } from 'vitest';
import { distance } from '../../src/sim/math/vec';
import { meadowScenario, meadowSegments, meadowTips, planMeadowRoad, type MeadowEdit } from '../../src/sim/scenarios/meadow';
import type { HouseholdView, TownView } from '../../src/sim/town/town';
import { DT, World } from '../../src/sim/world';

const MINUTE = 1 / DT;
const DAY = 1440 * MINUTE;

function connected(): MeadowEdit[] {
  const [west, east] = meadowTips([]);
  const road = planMeadowRoad([], west!, east!);
  if (!road.ok) throw new Error(road.reason);
  return [road.road];
}

function view(world: World): TownView {
  const town = world.townView();
  if (!town) throw new Error('meadow has a town');
  return town;
}

/** A resident is driving exactly while one live car is theirs. */
function expectDrivingMatchesCars(world: World, town: TownView): void {
  const cars = new Map<number, number>();
  const V = world.vehicles;
  for (let slot = 0; slot < V.highWater; slot++) {
    if (V.alive[slot] && V.owner[slot]! >= 0) cars.set(V.owner[slot]!, (cars.get(V.owner[slot]!) ?? 0) + 1);
  }
  for (const person of town.households.flatMap((h) => h.members)) {
    const driving = person.activity === 'outbound' || person.activity === 'homebound';
    expect(cars.get(person.id) ?? 0, `${person.firstName} (${person.id}) ${person.activity}`).toBe(driving ? 1 : 0);
    cars.delete(person.id);
  }
  expect([...cars.keys()]).toEqual([]);
}

/** Step whole minutes, checking the driving invariant every minute. */
function live(world: World, minutes: number, each?: (town: TownView) => void): void {
  for (let m = 0; m < minutes; m++) {
    for (let t = 0; t < MINUTE; t++) world.step();
    const town = view(world);
    expectDrivingMatchesCars(world, town);
    each?.(town);
  }
}

const side = (town: TownView, region: string): HouseholdView[] => town.households.filter((h) => h.region === region);
const mean = (households: HouseholdView[], f: (h: HouseholdView) => number): number =>
  households.reduce((sum, h) => sum + f(h), 0) / households.length;

describe('Meadow Vale residents', () => {
  it('commute only through their own portal before the neighbourhoods connect, and earn wages', () => {
    const world = new World(meadowScenario(), 1);
    live(world, 3 * 1440, (town) => {
      expect(town.totals.crossCommuters).toBe(0);
      for (const household of town.households) {
        for (const person of household.members) if (person.place) expect(person.place).toBe(household.region);
      }
    });
    const town = view(world);
    for (const household of town.households) {
      if (household.members.some((m) => m.job)) expect(household.wages).toBeGreaterThan(0);
    }
    expect(town.households.some((h) => h.wages > 0 && h.region === 'Westbrook')).toBe(true);
    expect(world.stats().completed).toBeGreaterThan(50);
    expect(world.stats().lost).toBe(0);
  });

  it('takes better-paid Eastford jobs from the West once a road connects them, and spends the money', () => {
    const apart = new World(meadowScenario(), 1);
    for (let t = 0; t < 10 * DAY; t++) apart.step();
    const before = side(view(apart), 'Westbrook');

    const world = new World(meadowScenario(connected()), 1);
    live(world, 10 * 1440, (town) => {
      if (town.minuteOfDay !== 3 * 60) return;
      // Every trip of the day has finished by 3 am: nobody is stuck on the road.
      for (const person of town.households.flatMap((h) => h.members)) expect(person.activity).toBe('home');
    });
    const town = view(world);
    const west = side(town, 'Westbrook');
    expect(west.flatMap((h) => h.members).filter((m) => m.job === 'Eastford').length).toBeGreaterThan(0);
    expect(town.totals.crossCommuters).toBeGreaterThan(0);
    expect(mean(west, (h) => h.wages)).toBeGreaterThan(1.5 * mean(before, (h) => h.wages));
    expect(mean(west, (h) => h.funds)).toBeGreaterThan(mean(before, (h) => h.funds));
    expect(town.totals.carsBought).toBeGreaterThanOrEqual(2);
    expect(town.totals.houseUpgrades).toBeGreaterThanOrEqual(2);
    expect(town.events.some((e) => e.kind === 'boughtCar')).toBe(true);
    expect(town.events.some((e) => e.kind === 'upgradedHouse')).toBe(true);
    expect(world.stats().lost).toBe(0);
  });

  it('leaves Westbrook jobs for Eastford the night after the road is built', () => {
    let world = new World(meadowScenario(), 1);
    live(world, 1440 - 390 + 3 * 60);
    const jobs = (town: TownView) => side(town, 'Westbrook').flatMap((h) => h.members).map((m) => m.job);
    const before = jobs(view(world));
    expect(before).toContain('Westbrook');
    const road = world.editNetwork(meadowScenario(connected()));
    if (!road.ok) throw new Error(road.reason);
    world = road.world;
    live(world, 1440);
    const after = jobs(view(world));
    expect(before.some((job, i) => job === 'Westbrook' && after[i] === 'Eastford')).toBe(true);
    expect(view(world).events).toContainEqual(expect.objectContaining({ kind: 'changedJob', region: 'Eastford' }));
    expect(world.stats().lost).toBe(0);
  });

  it('is deterministic per seed and gives other seeds other families', () => {
    const run = (seed: number): World => {
      const world = new World(meadowScenario(connected()), seed);
      for (let t = 0; t < DAY; t++) world.step();
      return world;
    };
    const families = (world: World): string[] =>
      view(world).households.map((h) => `${h.surname}: ${h.members.map((m) => `${m.firstName} ${m.age}`).join(', ')}`);
    expect(run(4).hash()).toBe(run(4).hash());
    expect(view(run(4))).toEqual(view(run(4)));
    expect(families(run(5))).not.toEqual(families(run(4)));
  });

  it('keeps workers waiting while their street is bulldozed and brings them home after undo', () => {
    let world = new World(meadowScenario(), 1);
    live(world, 12 * 60 - 390);
    const westWorkers = (town: TownView) => side(town, 'Westbrook').flatMap((h) => h.members).filter((m) => m.job === 'Westbrook');
    expect(westWorkers(view(world)).length).toBeGreaterThan(0);
    expect(westWorkers(view(world)).every((m) => m.activity === 'away')).toBe(true);

    const segment = meadowSegments([]).findIndex((chain) => chain.some((p) => distance(p, { x: -45, y: -8 }) < 1e-6));
    const bulldozed: MeadowEdit[] = [{ remove: segment }];
    const demolished = world.editNetwork(meadowScenario(bulldozed));
    if (!demolished.ok) throw new Error(demolished.reason);
    world = demolished.world;
    const wages = side(view(world), 'Westbrook').map((h) => h.wages);
    live(world, 6 * 60);
    expect(view(world).minuteOfDay).toBe(18 * 60);
    expect(westWorkers(view(world)).every((m) => m.activity === 'away' && m.place === 'Westbrook')).toBe(true);
    expect(side(view(world), 'Westbrook').map((h) => h.wages)).toEqual(wages);
    expect(side(view(world), 'Eastford').flatMap((h) => h.members).every((m) => m.activity !== 'away' || m.errand === 'shop')).toBe(true);

    const restored = world.editNetwork(meadowScenario([]));
    if (!restored.ok) throw new Error(restored.reason);
    world = restored.world;
    let refused = false;
    live(world, 60, (town) => {
      if (!refused && westWorkers(town).some((m) => m.activity === 'homebound')) {
        expect(world.editNetwork(meadowScenario(bulldozed)).ok).toBe(false);
        refused = true;
      }
    });
    expect(refused).toBe(true);
    expect(westWorkers(view(world)).every((m) => m.activity === 'home')).toBe(true);
    expect(side(view(world), 'Westbrook').every((h, i) => h.wages >= wages[i]!)).toBe(true);
    expect(world.stats().lost).toBe(0);
  });
});
