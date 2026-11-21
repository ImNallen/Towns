import { expect, it } from 'vitest';
import { meadowScenario } from '../../src/sim/scenarios/meadow';
import { World } from '../../src/sim/world';
import { parkFootprint, parksOn } from '../../src/sim/town/parks';
import { planZoneStroke } from '../../src/sim/zoning/paint';
import type { CellKey } from '../../src/sim/zoning/cells';
import { editCost } from '../../src/sim/town/budget';

it('charges for a park, benefits connected homes, and clears visiting families safely on removal', () => {
  const scenario = meadowScenario(),
    cells = scenario.zones!,
    w = new World(scenario, 1);
  const keys = parkFootprint(524388 as CellKey, 2);
  expect(planZoneStroke(cells,new Map(),'park',keys.slice(1)).ok).toBe(false);
  const plan = planZoneStroke(cells, new Map(), 'park', keys);
  if (!plan.ok) throw new Error(plan.reason);
  expect(editCost([], plan.stroke)).toBe(140);
  const before = w.townView()!;
  const zoning = new Map(keys.map((key) => [key, 'park'] as const));
  w.setZoning(zoning);
  const view = w.townView()!;
  expect(parksOn(cells, zoning)).toHaveLength(1);
  expect(view.budget.today.upkeep - before.budget.today.upkeep).toBe(8);
  const covered = view.households.filter((h) => h.nearbyPark);
  expect(covered.length).toBeGreaterThan(0);
  expect(covered.length).toBeLessThan(view.households.length);
  const boost = (h: (typeof covered)[number]) =>
    h.happiness - before.households.find((old) => old.id === h.id)!.happiness;
  for (const h of covered) {
    const base = before.households.find((old) => old.id === h.id)!.happiness;
    expect(h.happiness).toBeCloseTo(Math.min(1, base + 0.08 * (1 - h.nearbyPark!.metres / 450)), 3);
  }
  expect(covered.some((h) => boost(h) > 0)).toBe(true);
  expect(view.households.filter((h) => !h.nearbyPark).every((h) => boost(h) === 0)).toBe(true);
  for (let t = 0; t < 2 * 28800; t++) {
    w.step();
    if (t % 20 || !w.townView()!.parkVisitors) continue;
    expect(w.townView()!.parkVisits).toBeGreaterThan(0);
    expect(w.pedestrianPositions().length).toBeGreaterThan(w.walkers!.count * 3);
    w.setZoning(new Map());
    expect(w.townView()!.parkVisitors).toBe(0);
    for (let i = 0; i < 28800; i++) w.step();
    expect(w.stats().lost).toBe(0);
    return;
  }
  throw new Error('Expected leisure trips to the park');
});
