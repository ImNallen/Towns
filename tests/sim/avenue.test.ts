import { expect, it } from 'vitest';
import { NetworkBuilder } from '../../src/sim/network/builder';
import { buildStreetNetwork } from '../../src/sim/network/streets';
import { meadowScenario } from '../../src/sim/scenarios/meadow';
import { World } from '../../src/sim/world';

it.each([false,true])('separates avenue turn lanes and clears merges with lights=%s', lights => {
  const west={x:-160,y:0}, seam={x:-100,y:0}, centre={x:0,y:0};
  const north={x:0,y:120}, south={x:0,y:-120}, east={x:150,y:0};
  const {network,entries}=buildStreetNetwork(new NetworkBuilder(),
    [[west,seam],[seam,centre],[centre,north],[centre,south],[centre,east]],
    [west,north,south,east],[],['town','avenue','town','town','town'],lights?[centre]:[]);
  const demand=entries.map(lane=>({lane,rate:0.12}));
  const world=new World({...meadowScenario(),network,demand,town:undefined},3);
  function approach(destination:number) {
    const split=world.routing.nextHop(destination,entries[0]!);
    return world.routing.nextHop(destination,split);
  }
  const left=approach(1), right=approach(2);
  expect(left).not.toBe(right);
  expect(network.lanes[left]!.kind).toBe('road');
  expect(network.lanes[right]!.kind).toBe('road');
  const seen=new Set<number>();
  const v=world.vehicles;
  for(let t=0;t<18000;t++) {
    world.step();
    const occupied=new Set<number>();
    for(let i=0;i<v.highWater;i++) if(v.alive[i]) {
      const lane=v.lane[i]!;
      occupied.add(lane);
      seen.add(lane);
      for(let j=0;j<i;j++) if(v.alive[j] && v.lane[j]===lane) {
        const front=v.s[i]!>v.s[j]!?i:j;
        if(Math.abs(v.s[i]!-v.s[j]!) + 0.001 < v.length[front]!) throw new Error('Overlap on lane '+lane+' at tick '+t);
      }
    }
    for(const lane of occupied) for(const other of network.lanes[lane]!.crossingYieldTo) {
      if(occupied.has(other)) throw new Error('Conflicting entries at tick '+t);
    }
  }
  expect(seen.has(left) && seen.has(right)).toBe(true);
  expect(world.stats().completed).toBeGreaterThan(50);
  expect(world.stats().lost).toBe(0);
});

it('routes from one regional source to both branches of an avenue T and back to one sink', () => {
  const west={x:-120,y:0}, centre={x:0,y:0}, north={x:0,y:100}, south={x:0,y:-100};
  const {network,entries}=buildStreetNetwork(new NetworkBuilder(),
    [[west,centre],[centre,north],[centre,south]], [west,north,south], [], ['avenue','town','town']);
  const world=new World({...meadowScenario(),network,town:undefined,demand:[]},7);
  for(const dest of [1,2]) {
    expect(world.routing.canReach(dest,entries[0]!)).toBe(true);
    expect(world.routing.canReach(0,entries[dest]!)).toBe(true);
  }
  expect(world.routing.nextHop(1,entries[0]!)).not.toBe(world.routing.nextHop(2,entries[0]!));
  expect(network.sinks).toHaveLength(3);
});
