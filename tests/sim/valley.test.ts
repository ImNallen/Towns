import { expect, it } from 'vitest';
import { buildScenario } from '../../src/sim/scenarios';
import { meadowZoning, valley } from '../../src/sim/scenarios/meadow';
import { planZoneStroke } from '../../src/sim/zoning/paint';
import type { CellKey } from '../../src/sim/zoning/cells';
import { World } from '../../src/sim/world';

it('grows a deterministic first neighbourhood from empty frontage at the western entrance', () => {
  function run() {
    const scenario = buildScenario('valley');
    expect(scenario.bounds).toEqual({ minX: -1000, maxX: 1000, minY: -1000, maxY: 1000 });
    expect(scenario.network.sinks).toHaveLength(3);
    expect(scenario.town!.homes).toHaveLength(0);
    const road = valley.planMeadowRoad([], { x: -870, y: 0 }, { x: -700, y: 0 });
    if (!road.ok) throw new Error(road.reason);
    const grown = valley.meadowScenario([road.road]);
    const world = new World(scenario, 1);
    const result = world.editNetwork(grown);
    if (!result.ok) throw new Error(result.reason);
    const cells = grown.zones!;
    const zone = planZoneStroke(
      cells,
      new Map(),
      'residential',
      Array.from(cells.keys, (key) => key as CellKey),
    );
    if (!zone.ok) throw new Error(zone.reason);
    result.world.setZoning(meadowZoning([road.road, zone.stroke], cells));
    for (let i = 0; i < 600; i++) result.world.step();
    expect(result.world.townView()!.households.length).toBeGreaterThan(0);
    expect(result.world.stats().lost).toBe(0);
    return result.world.hash();
  }
  expect(run()).toBe(run());
});

it('admits intertown traffic between connected entrances while Northfield is still isolated', () => {
  const road = valley.planMeadowRoad([], { x: -870, y: 0 }, { x: 994, y: 0 });
  if (!road.ok) throw new Error(road.reason);
  const linked = valley.meadowScenario([road.road]);
  expect(linked.demand.map((d) => d.lane)).toEqual(linked.town!.regions.slice(0, 2).map((r) => r.source));
});
