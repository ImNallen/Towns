import { valley, meadowZoning, type MeadowEdit } from '../src/sim/scenarios/meadow';
import { World } from '../src/sim/world';
import { editCost } from '../src/sim/town/budget';
import { decodeCellKey, type CellKey } from '../src/sim/zoning/cells';
import { planZoneStroke, type LandUse } from '../src/sim/zoning/paint';
import type { RoadType } from '../src/sim/network/roadTypes';

export function plantValley() {
  const edits: MeadowEdit[] = [];
  let world = new World(valley.meadowScenario(), 1);
  // Capital grant for the benchmark subdivision. The playable map starts with the normal treasury.
  world.treasury!.balance += 150000;
  function apply(edit: MeadowEdit) {
    const cost = editCost(edits, edit, valley);
    edits.push(edit);
    if ('zone' in edit) {
      world.setZoning(meadowZoning(edits, world.scenario.zones!));
    } else {
      const scenario = valley.meadowScenario(edits);
      const result = world.editNetwork(scenario, meadowZoning(edits, scenario.zones!));
      if (!result.ok) throw new Error(result.reason);
      world = result.world;
    }
    const shortage = world.treasury!.book(cost);
    if (shortage) throw new Error(shortage);
    world.step();
  }
  function road(x: number, y: number, ex: number, ey: number, type: RoadType) {
    const plan = valley.planMeadowRoad(edits, { x, y }, { x: ex, y: ey }, undefined, type);
    if (!plan.ok) throw new Error(type + ' at ' + x + ',' + y + ': ' + plan.reason);
    apply(plan.road);
  }
  road(-870, 0, 180, 0, 'town');
  road(-800, 0, -800, -670, 'avenue');
  for (const y of [-100, -200, -300, -400, -500, -600]) road(-800, y, 160, y, 'town');
  road(-320, -630, -320, 0, 'town');
  road(80, -630, 80, 0, 'town');
  road(160, -300, 230, -300, 'parking');
  for (const [i, j] of world.network.junctions!.entries()) {
    if (i >= 3) break;
    apply({ lights: j.point, actuated: i % 2 === 0 });
  }
  for (const y of [-100, -300, -500]) {
    const p = { x: -420, y };
    const plan = valley.planWalk(world.network, 'zebra', p, p);
    if (typeof plan === 'string') throw new Error(plan);
    apply(plan);
  }

  const cells = world.scenario.zones!;
  const released = new Set<CellKey>();
  function releaseDistrict(target: number) {
    const byUse = new Map<LandUse, CellKey[]>();
    for (let i = 0; i < cells.count; i++) {
      const key = cells.keys[i]! as CellKey;
      if (released.has(key)) continue;
      const { row, column, side } = decodeCellKey(key);
      if (row !== 0) continue;
      const x = cells.corners[i * 8]!;
      const y = cells.corners[i * 8 + 1]!;
      if (target <= 150 && (x > -480 || y < -225)) continue;
      if (target <= 500 && (x > -140 || y < -425)) continue;
      released.add(key);
      let use: LandUse = 'residential';
      if (column % 61 === 10 && side === 1) use = 'parking';
      else if (column % 30 === 5) use = 'shops';
      else if (column % 19 === 2) use = 'workplaces';
      const keys = byUse.get(use) ?? [];
      // Two-deep paint leaves room for detached homes, yards, and business bays.
      keys.push(use === 'parking' ? key : ((key + 1) as CellKey));
      byUse.set(use, keys);
    }
    const residential = byUse.get('residential')!;
    const park = (residential.shift()! - 1) as CellKey;
    const paint = (use: LandUse, keys: CellKey[]) => {
      const plan = planZoneStroke(cells, meadowZoning(edits, cells), use, keys);
      if (!plan.ok) throw new Error(plan.reason);
      apply(plan.stroke);
    };
    paint('park', [park]);
    for (const use of ['parking', 'shops', 'workplaces', 'residential'] as const) {
      const keys = byUse.get(use);
      if (keys?.length) paint(use, keys);
    }
  }
  return { world, edits, releaseDistrict };
}

export function growTo(town: ReturnType<typeof plantValley>, target: number) {
  const { world } = town;
  town.releaseDistrict(target);
  let count = 0;
  while (count < target) {
    for (let i = 0; i < 400; i++) world.step();
    count = world.townView()!.households.length;
    if (world.stats().lost || world.tick > 500000)
      throw new Error(JSON.stringify({ target, count, tick: world.tick, lost: world.stats().lost }));
  }
  return count;
}
