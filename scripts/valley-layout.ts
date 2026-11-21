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
    const plan = valley.planMeadowRoad(edits, { x,y }, { x:ex, y:ey }, undefined, type);
    if (!plan.ok) throw new Error(type + ' at ' + x + ',' + y + ': ' + plan.reason);
    apply(plan.road);
  }
  road(-870,0,180,0,'town');
  road(-800,0,-800,-670,'avenue');
  for (const y of [-100,-200,-300,-400,-500,-600]) road(-800,y,160,y,'town');
  road(-320,-630,-320,0,'town');
  road(80,-630,80,0,'town');
  road(160,-300,230,-300,'parking');
  for (const [i,j] of world.network.junctions!.entries()) {
    if (i >= 3) break;
    apply({ lights:j.point, actuated:i % 2 === 0 });
  }
  for (const y of [-100,-300,-500]) {
    const p = { x:-420,y };
    const plan = valley.planWalk(world.network,'zebra',p,p);
    if (typeof plan === 'string') throw new Error(plan);
    apply(plan);
  }

  const cells = world.scenario.zones!;
  const byUse = new Map<LandUse, CellKey[]>();
  for (const raw of cells.keys) {
    const key = raw as CellKey;
    const { row,column,side,road } = decodeCellKey(key);
    if (row !== 0) continue;
    const use: LandUse = column % 61 === 10 && side === 1 ? 'parking'
      : column % 30 === 5 ? 'shops' : column % 19 === 2 ? 'workplaces'
      : road === 4 && column === 10 && side === 0 ? 'park' : 'residential';
    if (!byUse.has(use)) byUse.set(use,[]);
    byUse.get(use)!.push(key);
  }
  for (const [use, keys] of byUse) {
    const plan = planZoneStroke(cells, meadowZoning(edits,cells), use, keys);
    if (!plan.ok) throw new Error(plan.reason);
    apply(plan.stroke);
  }
  return { world, edits };
}

export function growTo(world: World, target: number) {
  let count = 0;
  while (count < target) {
    for (let i=0;i<400;i++) world.step();
    count = world.townView()!.households.length;
    if (world.stats().lost || world.tick > 500000) throw new Error(JSON.stringify({target,count,tick:world.tick,lost:world.stats().lost}));
  }
  return count;
}
