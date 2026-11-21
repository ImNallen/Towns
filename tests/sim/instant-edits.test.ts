import { describe, expect, it } from 'vitest';
import { runEditSequence, sameLaneOverlaps } from '../../scripts/edits';
import { meadowScenario, meadowTips, planMeadowRoad } from '../../src/sim/scenarios/meadow';
import type { CellKey } from '../../src/sim/zoning/cells';
import { DT, World } from '../../src/sim/world';

describe('road edits under live traffic', () => {
  const { rows, world } = runEditSequence(7);

  it('applies every edit at once without overlaps, and clears cars only where roads change under them', () => {
    expect(rows.map((row) => row.edit)).toEqual([
      'connect with an arch', 'T junction on the arch', 'bypass across the arch',
      'four-way across the bypass', 'bulldoze a bypass segment', 'undo the bulldozing',
    ]);
    expect(rows.slice(1).every((row) => row.active > 5)).toBe(true);
    expect(rows.every((row) => row.overlaps === 0)).toBe(true);
    expect(rows.find((row) => row.edit === 'bulldoze a bypass segment')!.cleared).toBeGreaterThan(0);
    const cleared = Object.fromEntries(rows.map((row) => [row.edit, row.cleared]));
    expect(cleared).toMatchObject({
      'T junction on the arch': 0, 'bypass across the arch': 0, 'four-way across the bypass': 0, 'undo the bulldozing': 0,
    });
    expect(world.stats().cleared).toBe(rows.reduce((sum, row) => sum + row.cleared, 0));
    expect(world.stats().lost).toBe(0);
  });

  it('keeps completing trips after every edit', () => {
    const { rows, world } = runEditSequence(7);
    for (let i = 1; i < rows.length; i++) expect(rows[i]!.completed).toBeGreaterThan(rows[i - 1]!.completed);
    const completed = world.stats().completed;
    let overlaps = 0;
    for (let t = 0; t < 120 / DT; t++) {
      world.step();
      overlaps += sameLaneOverlaps(world);
    }
    expect(overlaps).toBe(0);
    expect(world.stats().completed).toBeGreaterThan(completed + 10);
    expect(world.stats().lost).toBe(0);
  });

  it('reproduces the same state for the same seed and edits', () => {
    const again = runEditSequence(7);
    expect(again.rows).toEqual(rows);
    expect(again.world.hash()).toBe(world.hash());
    expect(runEditSequence(8).world.hash()).not.toBe(world.hash());
  });
});

it('releases an interrupted freight trip so the business can request its next delivery', () => {
  const [west, east] = meadowTips([]);
  const road = planMeadowRoad([], west!, east!);
  if (!road.ok) throw new Error(road.reason);

  // The shop receives freight from across the connecting road.
  const layout = (connected: boolean) => {
    const scenario = meadowScenario(connected ? [road.road] : []);
    const town = scenario.town!;
    const regions = town.regions.map((r, i) => ({ ...r, source: town.regions[1 - i]!.source }));
    return { ...scenario, town: { ...town, regions } };
  };
  const connected = layout(true);
  const world = new World(connected, 1);
  world.setZoning(new Map([[524392 as CellKey, 'shops']]));
  const vans = world.vehicles;
  for (let tick = 0; tick < 288000; tick++) {
    world.step();
    if (!vans.owner.subarray(0, vans.highWater).some((owner, slot) => owner < -1 && vans.alive[slot])) continue;
    const cut = world.editNetwork(layout(false));
    if (!cut.ok) throw new Error(cut.reason);
    expect(cut.world.stats()).toMatchObject({ deliveries: 0, lost: 0 });
    expect(cut.world.stats().cleared).toBeGreaterThan(0);
    expect(cut.world.vehicles.owner.some((owner, slot) => owner < -1 && cut.world.vehicles.alive[slot])).toBe(false);
    const restored = cut.world.editNetwork(connected);
    if (!restored.ok) throw new Error(restored.reason);
    for (let t = 0; t < 28800 && !restored.world.stats().deliveries; t++) restored.world.step();
    expect(restored.world.stats().deliveries).toBe(1);
    return;
  }
  throw new Error('Expected an inbound shop delivery');
});
