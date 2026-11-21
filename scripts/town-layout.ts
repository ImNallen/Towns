import { Model } from '../src/vehicles/catalogue';
import { meadowScenario, meadowTips, planMeadowRoad, planWalk, type MeadowEdit } from '../src/sim/scenarios/meadow';
import { decodeCellKey, type CellKey } from '../src/sim/zoning/cells';
import { planZoneStroke, type LandUse } from '../src/sim/zoning/paint';
import { parkFootprint } from '../src/sim/town/parks';
import { World } from '../src/sim/world';

export type TownLayout = 'Sensible' | 'Well-planned' | 'Jammed';

export function studyTown(layout: TownLayout) {
  const [west, east] = meadowTips([]);
  const road = planMeadowRoad([], west!, east!);
  if (!road.ok) throw new Error(road.reason);
  const edits: MeadowEdit[] = [road.road];
  if (layout === 'Well-planned') {
    for (const point of [{ x: -110, y: -8 }, { x: 98, y: 8 }, { x: 0, y: 0 }]) {
      const crossing = planWalk(meadowScenario(edits).network, 'zebra', point, point);
      if (typeof crossing === 'string') throw new Error(crossing);
      edits.push(crossing);
    }
  }
  const scenario = meadowScenario(edits);
  if (layout === 'Jammed') {
    // The same residential street doubles as a freight through-route.
    for (const source of scenario.demand.slice()) scenario.demand.push({ ...source, model: Model.Lorry, rate: 0.2 });
  }
  const world = new World(scenario, 1);
  const cells = scenario.zones!;
  const zoning = new Map<CellKey, LandUse>();
  for (const raw of cells.keys) {
    const key = raw as CellKey;
    const { column, side } = decodeCellKey(key);
    const band = (column + side * 2) % 6;
    zoning.set(key, band < 3 ? 'residential' : band === 3 ? 'shops' : 'workplaces');
  }
  if (layout === 'Well-planned') {
    const served = new Set<string>();
    for (const raw of cells.keys) {
      const key = raw as CellKey;
      const { road, row, side } = decodeCellKey(key);
      const frontage = road + '/' + side;
      if (row || served.has(frontage)) continue;
      const park = parkFootprint(key, 3);
      if (!planZoneStroke(cells, new Map(), 'park', park).ok) continue;
      for (const cell of park) zoning.set(cell, 'park');
      served.add(frontage);
    }
  }
  world.setZoning(zoning);
  return world;
}
