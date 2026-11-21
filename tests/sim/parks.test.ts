import { expect, it } from 'vitest';
import { meadowScenario } from '../../src/sim/scenarios/meadow';
import { World } from '../../src/sim/world';
import { parkBenefit, parkFootprint, parksOn } from '../../src/sim/town/parks';
import { planZoneStroke, type LandUse } from '../../src/sim/zoning/paint';
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
    expect(h.happiness).toBeCloseTo(Math.min(1, base + parkBenefit(4,h.nearbyPark!.metres)), 3);
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

it('gives bigger parks a wider walking catchment and stronger local effect', () => {
  expect(parkBenefit(1,450)).toBe(0);
  expect(parkBenefit(4,450)).toBeGreaterThan(0);
  expect(parkBenefit(9,600)).toBeGreaterThan(0);
  expect(parkBenefit(9,Infinity)).toBe(0);
  expect(parkBenefit(9,20)).toBeGreaterThan(parkBenefit(4,20));
  expect(parkBenefit(4,20)).toBeGreaterThan(parkBenefit(4,200));
  expect(parkBenefit(20,20)).toBe(parkBenefit(9,20));
});

it('brings forward growth on a covered home lot while keeping the same build cost', () => {
  const scenario=meadowScenario(), home=524404 as CellKey;
  const firstMove=(size:number) => {
    const world=new World(scenario,1);
    const zoning = new Map<CellKey,LandUse>([[home,'residential']]);
    for (const key of parkFootprint(524388 as CellKey,size)) zoning.set(key,'park');
    world.setZoning(zoning);
    const initial=world.townView()!.households.length;
    for(let tick=0;tick<28800;tick++){
      world.step();
      if(tick%100===0 && world.townView()!.households.length>initial) return tick;
    }
    throw new Error('Expected the home lot to grow');
  };
  expect(firstMove(2)).toBeLessThan(firstMove(0));
});
