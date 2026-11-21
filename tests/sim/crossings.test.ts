import { expect, it } from 'vitest';
import { meadowScenario, meadowTips, planMeadowRoad, planWalk } from '../../src/sim/scenarios/meadow';
import { editCost,undoCost } from '../../src/sim/town/budget';
import { World } from '../../src/sim/world';
import { decodeCellKey,type CellKey } from '../../src/sim/zoning/cells';

it('holds vehicle bodies clear throughout occupied zebra crossings under mixed traffic', () => {
  const [a,b]=meadowTips([]);
  const road=planMeadowRoad([],a!,b!);
  if (!road.ok) throw new Error(road.reason);
  const p={x:-110,y:-8};
  const edit=planWalk(meadowScenario([road.road]).network,'zebra',p,p);
  if (typeof edit==='string') throw new Error(edit);
  const scenario=meadowScenario([road.road,edit]);
  const w=new World(scenario,1);
  w.setZoning(new Map(Array.from(scenario.zones!.keys,raw=>{
    const key=raw as CellKey, {column,side}=decodeCellKey(key), band=(column+side*2)%6;
    return [key,band<3?'residential':band===3?'shops':'workplaces'] as const;
  })));
  const crossing=w.walkers!.graph.crossings.find(c=>c.zebra)!;
  let occupied=0;
  for(let t=0;t<288000;t++){
    w.step();
    if (!crossing.occupied) continue;
    occupied++;
    for(const z of crossing.lanes) {
      const v=w.vehicles;
      for(let i=0;i<v.highWater;i++) {
        if(!v.alive[i] || v.lane[i]!==z.lane) continue;
        if(v.s[i]! > z.from+0.001 && v.s[i]!-v.length[i]! < z.to-0.001) throw new Error('Vehicle occupies crossing at tick '+t);
      }
    }
  }
  expect(occupied).toBeGreaterThan(100);
  expect(crossing.served).toBeGreaterThan(25);
  expect(crossing.yieldingTicks).toBeGreaterThan(100);
  expect(w.stats().lost).toBe(0);
  expect(w.stats().completedLastMinute).toBeGreaterThan(0);
});

it('builds a low-cost reversible footpath and requires a paved road for zebras',()=>{
  const n=meadowScenario().network;
  const path=planWalk(n,'footpath',{x:48,y:4},{x:30,y:-14});
  if (typeof path==='string') throw new Error(path);
  expect(meadowScenario([path]).network.surfaces.some(s=>s.style==='footpath')).toBe(true);
  expect(editCost([],path)).toBeLessThan(60);
  expect(undoCost([path])).toBe(-editCost([],path));
  expect(meadowScenario([path]).town!.roadUpkeep).toBeGreaterThan(meadowScenario().town!.roadUpkeep!);
  const p={x:-110,y:-8};
  expect(typeof planWalk(meadowScenario([{upgrade:0,roadType:'country'}]).network,'zebra',p,p)).toBe('string');
});
