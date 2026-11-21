import { expect, it } from 'vitest';
import { nextActuatedClock, signalAspect } from '../../src/sim/network/signals';
import { meadowScenario, planMeadowRoad } from '../../src/sim/scenarios/meadow';
import { editCost, undoCost } from '../../src/sim/town/budget';
import { decodeCellKey, type CellKey } from '../../src/sim/zoning/cells';
import { World } from '../../src/sim/world';

it.each([false,true])('clears conflicting movements and occupied crossings every tick with actuated=%s', actuated => {
  const point = { x:-65,y:-8 };
  const crossing = planMeadowRoad([],{x:-65,y:-45},{x:-65,y:62});
  if (!crossing.ok) throw new Error(crossing.reason);
  const link = planMeadowRoad([crossing.road],{x:-45,y:-8},{x:45,y:8});
  if (!link.ok) throw new Error(link.reason);
  const roads = [crossing.road,link.road], light = {lights:point,actuated};
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
  world.setZoning(new Map(Array.from(after.zones!.keys, raw => {
    const key = raw as CellKey, { column, side } = decodeCellKey(key);
    const band = (column + side*2) % 6;
    return [key, band<3?'residential':band===3?'shops':'workplaces'] as const;
  })));
  let entries=0;
  let walkingTicks=0;
  const occupiedLastTick = new Set<import('../../src/sim/traffic/pedestrianConflicts').Crossing>();
  const previous = new Int32Array(v.capacity);
  for(let tick=0;tick<57600;tick++) {
    const phase = actuated ? world.signalClocks[0]! : world.tick;
    previous.set(v.lane);
    world.step();
    const occupied = new Set<number>();
    for(let i=0;i<v.highWater;i++) if(v.alive[i]) {
      occupied.add(v.lane[i]!);
      const arm=arms.find(a=>a.incoming===previous[i]);
      if(arm && world.network.lanes[arm.incoming]!.next.includes(v.lane[i]!)) {
        expect(signalAspect(arm.group,phase)).toBe('green');
        entries++;
      }
    }
    for(const lane of occupied) {
      for(const other of world.network.lanes[lane]!.crossingYieldTo) {
        expect(occupied.has(other)).toBe(false);
      }
    }
    for(const c of world.walkers!.graph.crossings) {
      if (!c.occupied || c.walkGroup === undefined) { occupiedLastTick.delete(c); continue; }
      if (!occupiedLastTick.has(c)) expect(signalAspect(c.walkGroup,phase)).toBe('green');
      occupiedLastTick.add(c);
      walkingTicks++;
      for(const zone of c.lanes) for(let i=0;i<v.highWater;i++) {
        if(v.alive[i] && v.lane[i]===zone.lane) if (v.s[i]! > zone.from+0.001 && v.s[i]!-v.length[i]! < zone.to-0.001) throw new Error('Walker conflict at tick '+tick);
      }
    }
  }
  expect(walkingTicks).toBeGreaterThan(100);
  expect(entries).toBeGreaterThan(20);
  expect(world.stats().lost).toBe(0);
  expect(world.editNetwork(before).ok).toBe(true);
});

it('rests on the main green until a waiting pedestrian calls the side phase without a car', () => {
  const point = {x:-65,y:-8};
  const side = planMeadowRoad([],point,{x:-65,y:62});
  if(!side.ok) throw new Error(side.reason);
  const scenario = meadowScenario([side.road,{lights:point,actuated:true}]);
  // Run after midnight, before residents depart for work.
  const w = new World({ ...scenario, demand: [] }, 1, 4096, (1440 - 390 + 60) * 20);
  for(let i=0;i<1500;i++) {
    w.step();
    expect(signalAspect(0,w.signalClocks[0]!)).toBe('green');
  }
  const walkers=w.walkers!, graph=walkers.graph;
  // Start at the kerb of a main-road crossing, heading towards a reachable home.
  let placed=false;
  for(let dest=0;dest<graph.places.length && !placed;dest++) {
    for(let node=0;node<graph.edges.length;node++) {
      const edge=graph.edges[node]!.find(e=>e.to===graph.next[dest]![node] && e.crossing?.walkGroup===1);
      if(!edge) continue;
      walkers.goal[0]=dest;
      walkers.node[0]=node;
      walkers.speed[0]=1.4;
      walkers.count=1;
      placed=true;
      break;
    }
  }
  expect(placed).toBe(true);
  let started=false;
  for(let i=0;i<500;i++) {
    const phase=w.signalClocks[0]!;
    w.step();
    if(!started && walkers.along[0]!>0) {
      expect(signalAspect(1,phase)).toBe('green');
      started=true;
    }
  }
  expect(started).toBe(true);
  expect(w.vehicles.count).toBe(0);
});

it('honours minimum green, caps a sustained side phase and clears before returning to main', () => {
  let clock=0;
  for(let i=0;i<199;i++) clock=nextActuatedClock(clock,true);
  expect(signalAspect(0,clock)).toBe('green');
  clock=nextActuatedClock(clock,true);
  expect(signalAspect(0,clock)).toBe('amber');
  for(let i=0;i<100;i++) clock=nextActuatedClock(clock,true);
  expect(signalAspect(1,clock)).toBe('green');
  let quiet=clock;
  for(let i=0;i<99;i++) quiet=nextActuatedClock(quiet,false);
  expect(signalAspect(1,quiet)).toBe('green');
  expect(signalAspect(1,nextActuatedClock(quiet,false))).toBe('amber');
  for(let i=0;i<300;i++) clock=nextActuatedClock(clock,true);
  expect(signalAspect(1,clock)).toBe('amber');
  for(let i=0;i<60;i++) clock=nextActuatedClock(clock,true);
  expect(signalAspect(1,clock)).toBe('red');
  expect(signalAspect(0,clock)).toBe('red');
  for(let i=0;i<40;i++) clock=nextActuatedClock(clock,true);
  expect(signalAspect(0,clock)).toBe('green');
});
