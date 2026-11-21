import { expect, test } from 'vitest';
import { HouseLayer } from '../../src/render/houses';
import { meadowScenario } from '../../src/sim/scenarios/meadow';
import { World } from '../../src/sim/world';
import { cellKey, decodeCellKey, findCell, type CellKey } from '../../src/sim/zoning/cells';
import { cellQuad } from '../../src/render/zones';

test('the rear garden selects its house and shrinks when just the last row is erased', () => {
  const scenario = meadowScenario();
  const cells = scenario.zones!;
  const zoning = new Map(Array.from(cells.keys, k => [k as CellKey, 'residential'] as const));
  const world = new World(scenario, 1);
  world.setZoning(zoning);
  for (let tick = 0; tick < 28800; tick++) world.step();
  const view = world.townView()!;
  const house = view.households.find(h => h.lot && h.lot.columns === 1)!;
  const lot = house.lot!;
  const { road, side, column } = decodeCellKey(lot.key);
  const rear = cellKey(road, column, side, 3);
  const nearer = cellKey(road, column, side, 2);
  const center = (key: CellKey) => cellQuad(cells, findCell(cells, key))
    .reduce((p, q) => ({ x: p.x + q.x / 4, y: p.y + q.y / 4 }), { x: 0, y: 0 });
  const layer = new HouseLayer(scenario.decor.houses);
  layer.setPaint({ cells, zoning });
  layer.update(view.households, []);
  expect(layer.houseAt(center(rear))).toBe(house.home);
  zoning.delete(rear);
  layer.setPaint({ cells, zoning });
  layer.update(view.households, []);
  expect(layer.houseAt(center(rear))).toBeNull();
  expect(layer.houseAt(center(nearer))).toBe(house.home);
});
