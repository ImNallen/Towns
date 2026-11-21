import { expect, it } from 'vitest';
import { signalAspect } from '../../src/sim/network/signals';
import { meadowScenario, planMeadowRoad } from '../../src/sim/scenarios/meadow';
import { editCost, undoCost } from '../../src/sim/town/budget';
import { World } from '../../src/sim/world';

it('installs lights under traffic and clears conflicting movements and occupied crossings every tick', () => {
  const point = { x:-65,y:-8 };
  const crossing = planMeadowRoad([],{x:-65,y:-45},{x:-65,y:62});
  if (!crossing.ok) throw new Error(crossing.reason);
  const link = planMeadowRoad([crossing.road],{x:-45,y:-8},{x:45,y:8});
  if (!link.ok) throw new Error(link.reason);
  const roads = [crossing.road,link.road], light = {lights:point};
  const before = meadowScenario(roads), after = meadowScenario([...roads,light]);
  expect(editCost(roads,light)).toBe(160);
  expect(undoCost([...roads,light])).toBe(-160);
  expect(after.town!.roadUpkeep!-before.town!.roadUpkeep!).toBe(4);
  const initial = new World(before,1);
  for(let t=0;t<500;t++) initial.step();
  const changed = initial.editNetwork(after);
  if(!changed.ok) throw new Error(changed.reason);
  const world=changed.world, v=world.vehicles;
  const arms=after.network.junctions![0]!.arms;
  let entries=0;
  const previous = new Int32Array(v.capacity);
  for(let tick=0;tick<6000;tick++) {
    previous.set(v.lane);
    world.step();
    const occupied = new Set<number>();
    for(let i=0;i<v.highWater;i++) if(v.alive[i]) {
      occupied.add(v.lane[i]!);
      const arm=arms.find(a=>a.incoming===previous[i]);
      if(arm && world.network.lanes[arm.incoming]!.next.includes(v.lane[i]!)) {
        expect(signalAspect(arm.group,world.tick-1)).toBe('green');
        entries++;
      }
    }
    for(const lane of occupied) {
      for(const other of world.network.lanes[lane]!.crossingYieldTo) {
        expect(occupied.has(other)).toBe(false);
      }
    }
    for(const c of world.walkers!.graph.crossings) if(c.occupied) {
      for(const zone of c.lanes) for(let i=0;i<v.highWater;i++) {
        if(v.alive[i] && v.lane[i]===zone.lane) expect(v.s[i]!<zone.from || v.s[i]!-v.length[i]!>zone.to).toBe(true);
      }
    }
  }
  expect(entries).toBeGreaterThan(20);
  expect(world.stats().lost).toBe(0);
  expect(world.editNetwork(before).ok).toBe(true);
});
