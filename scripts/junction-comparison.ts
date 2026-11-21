/** Ten town days on the connected, mixed Meadow preset. Count crossings at the entry line. */
import { meadowScenario, planMeadowRoad, type MeadowEdit } from '../src/sim/scenarios/meadow';
import { decodeCellKey, type CellKey } from '../src/sim/zoning/cells';
import type { LandUse } from '../src/sim/zoning/paint';
import { DT, World } from '../src/sim/world';

for (const lights of [false,true]) {
  const edits: MeadowEdit[] = [];
  const point = {x:-65,y:-8};
  for (const [a,b] of [[{x:-45,y:-8},{x:45,y:8}], [point,{x:-65,y:62}]] as const) {
    const plan = planMeadowRoad(edits,a,b);
    if (!plan.ok) throw new Error(plan.reason);
    edits.push(plan.road);
  }
  if (lights) edits.push({lights:point});
  const scenario = meadowScenario(edits);
  const world = new World(scenario,1);
  const zoning = new Map<CellKey,LandUse>();
  for (const raw of scenario.zones!.keys) {
    const key = raw as CellKey, {column,side} = decodeCellKey(key);
    const band = (column+side*2)%6;
    zoning.set(key,band<3?'residential':band===3?'shops':'workplaces');
  }
  world.setZoning(zoning);
  const arms = world.network.junctions![0]!.arms;
  const results = arms.map(() => ({queueTicks:0, delay:0, passed:0, peak:0}));
  const vehicles = world.vehicles;
  const previous = new Int32Array(vehicles.capacity);
  const delay = new Float64Array(vehicles.capacity);
  for (let t=0;t<288000;t++) {
    previous.set(vehicles.lane.subarray(0,vehicles.highWater));
    world.step();
    arms.forEach((arm,index) => {
      const row = results[index]!, lane = world.network.lanes[arm.incoming]!;
      let queue=0;
      for(let i=0;i<vehicles.highWater;i++) {
        if (!vehicles.alive[i]) {delay[i]=0; continue;}
        if (vehicles.lane[i]===arm.incoming) {
          if (vehicles.v[i]!<1) queue++;
          delay[i]+=DT*Math.max(0,1-vehicles.v[i]!/Math.min(lane.speedLimit,vehicles.topSpeed[i]!));
        } else if(previous[i]===arm.incoming) {
          if (lane.next.includes(vehicles.lane[i]!)) { row.passed++; row.delay+=delay[i]!; }
          delay[i]=0;
        }
      }
      row.queueTicks+=queue;
      row.peak=Math.max(row.peak,queue);
    });
  }
  console.log(lights?'Lights':'Give way', 'lost',world.stats().lost);
  console.table(results.map((r,i)=>({lane:arms[i]!.incoming,meanQueue:r.queueTicks/288000,peak:r.peak,delay:r.delay/Math.max(1,r.passed),throughput:r.passed})));
}
