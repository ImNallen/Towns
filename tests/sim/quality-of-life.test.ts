import { NetworkBuilder } from '../../src/sim/network/builder';
import { polyline } from '../../src/sim/math/polyline';
import { TrafficConditions } from '../../src/sim/traffic/conditions';
import { expect, it } from 'vitest';
import { studyTown, type TownLayout } from '../../scripts/town-layout';

it('links measured living conditions to household satisfaction and development', () => {
  function simulate(layout: TownLayout) {
    const w = studyTown(layout);
    const initial = w.townView()!.households.length;
    const reasons = new Set<string>();
    let departed = false;
    let previous = new Set<number>();
    for (let day = 0; day < 10; day++) {
      for (let tick = 0; tick < 28800; tick++) w.step();
      const households = w.townView()!.households;
      expect(households.length).toBeGreaterThanOrEqual(initial);
      const active = new Set(households.map(h => h.id));
      for (const id of previous) if (!active.has(id)) departed = true;
      previous = active;
      for (const h of households) for (const reason of h.reasons) reasons.add(reason.split(/ [−+]/)[0]!);
    }
    const town = w.townView()!;
    expect(w.stats().lost).toBe(0);
    return { mean: town.households.reduce((n, h) => n + h.happiness, 0) / town.households.length,
      upgrades: town.totals.houseUpgrades, reasons, departed };
  }
  const sensible = simulate('Sensible'), planned = simulate('Well-planned'), jam = simulate('Jammed');
  expect(sensible.mean).toBeGreaterThan(0.70);
  expect(sensible.mean).toBeLessThan(0.85);
  expect(planned.mean).toBeGreaterThan(0.90);
  expect(jam.mean).toBeLessThan(sensible.mean - 0.06);
  expect(planned.reasons.has('Park nearby')).toBe(true);
  expect(jam.reasons.has('Traffic noise')).toBe(true);
  expect(jam.reasons.has('Long commute')).toBe(true);
  expect(planned.reasons.has('No parking nearby') || sensible.reasons.has('No parking nearby')).toBe(true);
  expect(jam.upgrades).toBeLessThan(sensible.upgrades);
}, 30_000);

it('meters workplace lorries using the same service entrance', () => {
  const w = studyTown('Sensible');
  let deliveries = 0;
  for (let t = 0; t < 288000; t++) {
    w.step();
    if (t % 200) continue;
    const businesses = w.townView()!.businesses;
    const incoming = new Set<string>();
    for (let i = 0; i < w.vehicles.highWater; i++) {
      if (!w.vehicles.alive[i] || w.vehicles.owner[i]! >= -1 || w.vehicles.dest[i]! < w.routing.sinks.length) continue;
      const b = businesses.find(b => b.home === -2 - w.vehicles.owner[i]!);
      if (!b || b.zone !== 'workplaces') continue;
      const entrance = b.loadingBay.x + '/' + b.loadingBay.y;
      expect(incoming.has(entrance)).toBe(false);
      incoming.add(entrance);
    }
    for (const b of businesses) if (b.zone === 'workplaces') deliveries = Math.max(deliveries, b.deliveries);
  }
  expect(deliveries).toBeGreaterThan(0);
  expect(deliveries).toBeLessThanOrEqual(3);
}, 30000);

it('preserves roadside noise and household happiness across a live network rebuild', () => {
  const w = studyTown('Jammed');
  for (let i = 0; i < 28800; i++) w.step();
  const edit = w.editNetwork(w.scenario);
  if (!edit.ok) throw new Error(edit.reason);
  const edited = edit.world;
  expect(Math.max(...w.traffic.noiseDensity)).toBeGreaterThan(0.04);
  for (let i = 0; i < w.traffic.noiseDensity.length; i++) {
    expect(edited.traffic.noiseDensity[i]).toBeCloseTo(w.traffic.noiseDensity[i]!, 5);
  }
  w.step(); edited.step();
  expect(edited.townView()!.households.map(h => h.happiness)).toEqual(w.townView()!.households.map(h => h.happiness));
});

it('remaps a noisy road onto split lanes without giving a new branch its traffic history', () => {
  function network(split: boolean) {
    const b = new NetworkBuilder();
    const street = (x: number, to: number, y = 0) => b.addLane('road', polyline([{x, y: 0}, {x: to, y}]), 12);
    if (split) {
      const left = street(0, 20);
      b.connect(left, street(20, 80));
      b.connect(left, street(20, 20, 40));
    } else street(0, 80);
    return new TrafficConditions(b.build());
  }
  const before = network(false), split = network(true);
  before.noiseDensity[0] = 0.125;
  split.copyNoiseFrom(before);
  expect([...split.noiseDensity]).toEqual([0.125, 0.125, 0]);
  split.noiseDensity[1] = 0.25;
  before.copyNoiseFrom(split);
  expect(before.noiseDensity[0]).toBe(0.21875);
});
