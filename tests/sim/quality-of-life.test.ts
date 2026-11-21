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
