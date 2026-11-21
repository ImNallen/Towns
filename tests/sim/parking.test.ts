import { describe, expect, it } from 'vitest';
import { meadowScenario } from '../../src/sim/scenarios/meadow';
import { editCost, undoCost } from '../../src/sim/town/budget';
import { Parking, walkMinutes, type Bay } from '../../src/sim/town/parking';
import { Routing } from '../../src/sim/traffic/routing';
import { World } from '../../src/sim/world';
import { decodeCellKey, type CellKey } from '../../src/sim/zoning/cells';
import { planZoneStroke, type LandUse } from '../../src/sim/zoning/paint';

const scenario = meadowScenario();
const cells = scenario.zones!;
const start = 524388 as CellKey;
const lotCells = [start, (start + 8) as CellKey, (start + 16) as CellKey];

describe('parking', () => {
  it('uses own bays first, then the nearest reachable free bay within walking distance', () => {
    const access = scenario.town!.homes[0]!.access;
    const origin = scenario.town!.homes[1]!.access;
    const bays: Bay[] = [120, 20, 8, 260].map((x, i) => ({
      key: String(i),
      kind: i === 0 ? 'yard' : 'lot',
      home: i === 0 ? 0 : -1,
      x,
      y: 0,
      angle: 0,
      access,
    }));
    const routing = new Routing(
      scenario.network,
      bays.map((b) => b.access),
    );
    const parking = new Parking(bays, routing.sinks.length);
    const search = () => parking.nearest(0, { x: 0, y: 0 }, false, Uint8Array.of(1), origin, routing);
    for (const expected of [0, 2, 1]) {
      expect(search()).toBe(expected);
      parking.occupant[expected] = expected;
    }
    expect(search()).toBe(-1);
    expect(walkMinutes(14)).toBe(10);
    expect(walkMinutes(15)).toBe(11);
  });

  it('keeps extra cars on the apron when side bays belong to a disconnected street', () => {
    const westParking = meadowScenario([{ upgrade: 0, roadType: 'parking' }]);
    const world = new World(westParking, 1);
    for (let tick = 0; tick < 10 * 28800; tick++) world.step();
    const town = world.townView()!;
    const east = town.households.filter(h => h.region === 'Eastford');
    expect(east.some(h => h.cars === 2 && h.drivewayOverflow === 1)).toBe(true);
    expect(east.every(h => !h.parked.includes('street'))).toBe(true);
    expect(town.bays.some(b => b.kind === 'street' && b.x < 0)).toBe(true);
    expect(world.stats().lost).toBe(0);
  });

  it('requires the whole frontage, quotes the invoice, and refunds the lot on undo', () => {
    const plan = planZoneStroke(cells, new Map(), 'parking', lotCells);
    if (!plan.ok) throw new Error(plan.reason);
    const world = new World(scenario, 1);
    const before = world.townView()!.budget;
    expect(editCost([], plan.stroke)).toBe(240);
    expect(world.treasury!.book(editCost([], plan.stroke))).toBeUndefined();
    world.setZoning(new Map(lotCells.map((k) => [k, 'parking'])));
    const built = world.townView()!;
    expect(built.bays.filter((b) => b.kind === 'lot')).toHaveLength(6);
    expect(built.budget.today.upkeep - before.today.upkeep).toBe(6);
    expect(planZoneStroke(cells, new Map([[lotCells[1]!, 'shops']]), 'parking', lotCells).ok).toBe(false);
    world.treasury!.book(undoCost([plan.stroke]));
    world.setZoning(new Map());
    expect(world.townView()!.budget).toEqual(before);
    expect(world.townView()!.bays.some((b) => b.kind === 'lot')).toBe(false);
  });

  it('occupies the bay on arrival and reaches the door after the measured walk', () => {
    const world = new World(scenario, 1);
    const paint = new Map<CellKey, LandUse>();
    for (const raw of cells.keys) {
      const key = raw as CellKey;
      const { road, column, side } = decodeCellKey(key);
      if (road === 1 && column === 13 && side === 0) paint.set(key, 'shops');
    }
    world.setZoning(paint);
    for (let t = 0; t < 3 * 28800; t++) {
      const v = world.vehicles;
      const car = v.alive.findIndex((alive, i) => !!alive && v.owner[i]! >= 0 &&
        world.routing.exit(v.dest[i]!, v.lane[i]!) - v.s[i]! < 1);
      const owner = car < 0 ? -1 : v.owner[car]!;
      world.step();
      if (car < 0 || v.alive[car]) continue;
      const view = world.townView()!;
      const resident = view.households.flatMap(h => h.members).find(p => p.id === owner);
      const shop = view.businesses[0];
      if (!shop || resident?.place !== shop.name || resident.leg !== 'walk' || !shop.occupied) continue;
      const bay = view.bays.find(b => b.kind === 'yard' && b.model)!;
      const distance = Math.hypot(shop.lot.x-bay.x, shop.lot.y-bay.y);
      const due = (Math.floor(t/20) + walkMinutes(distance)) * 20;
      const person = () => world.townView()!.households.flatMap(h => h.members).find(p => p.id === owner)!;
      while (world.tick < due) world.step();
      expect(person().leg).toBe('walk');
      world.step();
      expect(person().activity).toBe('away');
      return;
    }
    throw new Error('Expected a resident to park in the shop yard');
  });

  it('waits at the kerb while another delivery unloads, then takes the shared bay', () => {
    const world = new World(scenario, 1);
    world.setZoning(new Map(Array.from(cells.keys, key => [key as CellKey, 'shops'])));
    world.setAdmissions(false);
    for (let tick = 0; tick < 6 * 28800; tick++) world.step();
    world.setAdmissions(true);
    let waiting = -1;
    for (let tick = 0; tick < 28800; tick++) {
      world.step();
      if (tick % 5) continue;
      const businesses = world.townView()!.businesses;
      if (waiting < 0) {
        const queued = businesses.find(b => b.waitingAtKerb);
        if (!queued) continue;
        waiting = queued.home;
        expect(queued.unloading).toBe(false);
        expect(Math.hypot(queued.kerb.x-queued.loadingBay.x,queued.kerb.y-queued.loadingBay.y)).toBeGreaterThan(10.8);
        expect(businesses.some(b => b.unloading && b.loadingBay.x === queued.loadingBay.x && b.loadingBay.y === queued.loadingBay.y)).toBe(true);
      } else if (businesses.some(b => b.home === waiting && b.unloading)) {
        expect(world.stats().lost).toBe(0);
        return;
      }
    }
    throw new Error('Expected the queued delivery to acquire its loading bay');
  });

  it('turns shoppers away from a shop without bays, then serves them with two public spaces', () => {
    const paint = new Map<CellKey, LandUse>([[524392 as CellKey, 'shops']]);
    const run = () => {
      const world = new World(scenario, 1);
      world.setZoning(paint);
      let visits = 0, refusedShopper = false;
      for (let tick = 0; tick < 5 * 28800; tick++) {
        world.step();
        if (tick % 100) continue;
        const view = world.townView()!;
        refusedShopper ||= view.events.some(e => e.kind === 'parkingFailed' && e.shopper);
        visits = Math.max(visits, view.businesses[0]?.customers ?? 0);
      }
      expect(world.stats().lost).toBe(0);
      return { visits, refusedShopper, refusals: world.townView()!.parking.turnedAway };
    };
    const before = run();
    expect(before.visits).toBe(0);
    expect(before.refusedShopper).toBe(true);
    paint.set(524400 as CellKey, 'parking');
    const after = run();
    expect(after.visits).toBeGreaterThan(0);
    expect(after.refusals).toBeLessThan(before.refusals);
  });

  it('circles full destinations, reports failures, and serves more drivers with a lot', () => {
    const mixed = new Map<CellKey, LandUse>();
    for (const raw of cells.keys) {
      const key = raw as CellKey;
      const { column, side } = decodeCellKey(key);
      const band = (column + side * 2) % 6;
      mixed.set(key, band < 3 ? 'residential' : band === 3 ? 'shops' : 'workplaces');
    }
    const run = () => {
      const world = new World(scenario, 1);
      world.setZoning(mixed);
      let searched = false,
        walked = false,
        failed = false;
      for (let tick = 0; tick < 288000; tick++) {
        world.step();
        if (world.tick % 28800 === (1440 - 390 + 180) * 20) {
          expect(world.townView()!.households.every(h => h.members.every(p => p.activity === 'home'))).toBe(true);
        }
        if (tick % 1200) continue;
        const town = world.townView()!;
        const activities = town.households.flatMap((h) => h.members.map((p) => p.activity));
        searched ||= activities.includes('searching');
        walked ||= activities.includes('walking');
        failed ||= town.events.some((e) => e.kind === 'parkingFailed');
        for (const business of town.businesses) {
          expect(business.occupied).toBeLessThanOrEqual(business.capacity);
        }
        const unloading = town.businesses.filter((b) => b.unloading).map((b) => JSON.stringify(b.loadingBay));
        expect(new Set(unloading).size).toBe(unloading.length);
      }
      expect([searched, walked, failed]).toEqual([true, true, true]);
      expect(world.stats().lost).toBe(0);
      return world.townView()!.parking;
    };
    const before = run();
    for (const key of lotCells) mixed.set(key, 'parking');
    const after = run();
    expect(after.turnedAway).toBeLessThan(before.turnedAway);
    expect(after.walkMetres).toBeGreaterThan(0);
  });
});
