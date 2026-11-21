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

it('balances through traffic at a fork, with clear merges and repeatable choices', () => {
  const west = {x:-320,y:0}, fork = {x:-160,y:0}, junction = {x:0,y:0};
  const east = {x:180,y:0}, north = {x:0,y:120};
  const {network,entries} = buildStreetNetwork(new NetworkBuilder(),
    [[west,fork],[fork,junction],[junction,east],[junction,north]],
    [west,east],[],['town','avenue','avenue','town'],[junction]);
  const [inner, outer] = network.avenuePairs![0]!;
  const run = () => {
    const w = new World({...meadowScenario(), network, demand:[{lane:entries[0]!,rate:0.48}], town:undefined}, 1);
    // Isolate local lane choice: the destination tree will always prefer the same lane.
    w.congestionAware = false;
    const v = w.vehicles;
    const previous = new Int32Array(v.capacity);
    const forkEntries = network.lanes[inner]!.prev.flatMap(a =>
      network.lanes[outer]!.prev.filter(b => network.lanes[a]!.prev[0] === network.lanes[b]!.prev[0]).map(b => [a, b]));
    expect(forkEntries.length).toBeGreaterThan(0);
    const lastMovement = new Int32Array(v.capacity).fill(-1);
    const lastDriver = new Int32Array(v.capacity);
    const passed = [0,0];
    let bothQueued = false;
    const occupied = new Set<number>();
    for (let t=0; t<24000; t++) {
      previous.set(v.lane.subarray(0,v.highWater));
      w.step();
      occupied.clear();
      let innerQueue=0, outerQueue=0;
      for (let i=0; i<v.highWater; i++) {
        if (!v.alive[i]) continue;
        const lane=v.lane[i]!;
        occupied.add(lane);
        if (network.lanes[lane]!.kind === 'connector') {
          lastMovement[i] = lane;
          lastDriver[i] = v.id[i]!;
        } else if (lastDriver[i] === v.id[i] && lastMovement[i]! >= 0 && v.s[i]! < v.length[i]!
          && network.lanes[lane]!.prev.includes(lastMovement[i]!)) {
          // The rear still occupies the connector after the front enters the receiving lane.
          occupied.add(lastMovement[i]!);
        }
        if (lane===inner && v.v[i]!<1) innerQueue++;
        if (lane===outer && v.v[i]!<1) outerQueue++;
        if (previous[i]===inner && network.lanes[inner]!.next.includes(lane)) passed[0]++;
        if (previous[i]===outer && network.lanes[outer]!.next.includes(lane)) passed[1]++;
        for (let j=0;j<i;j++) if(v.alive[j] && v.lane[j]===lane) {
          const leader = v.s[i]! > v.s[j]! ? i : j;
          if (Math.abs(v.s[i]!-v.s[j]!) < v.length[leader]!-0.001) throw new Error('Overlapping cars at tick '+t);
        }
      }
      bothQueued ||= innerQueue>=2 && outerQueue>=2;
      for (const [a,b] of forkEntries) {
        if (occupied.has(a!) && occupied.has(b!)) throw new Error('Overlapping fork entries at tick ' + t);
      }
      for (const lane of occupied) for (const other of network.lanes[lane]!.crossingYieldTo) {
        if (occupied.has(other)) throw new Error('Conflicting movements at tick '+t);
      }
    }
    expect(bothQueued).toBe(true);
    expect(Math.min(...passed)).toBeGreaterThan(100);
    expect(passed[0]!/(passed[0]!+passed[1]!)).toBeGreaterThan(0.4);
    expect(passed[0]!/(passed[0]!+passed[1]!)).toBeLessThan(0.6);
    expect(w.stats().lost).toBe(0);
    return w.hash();
  };
  expect(run()).toBe(run());
});

it('keeps drivers in the required turn lane even when the empty lane has a longer route to the destination', () => {
  const west={x:-150,y:0}, centre={x:0,y:0}, north={x:0,y:80}, northEnd={x:0,y:160};
  const south={x:0,y:-80};
  const {network,entries}=buildStreetNetwork(new NetworkBuilder(),
    [[west,centre],[centre,north],[north,northEnd],[centre,south],
      [south,{x:100,y:-80},{x:100,y:80},north]], [west,northEnd],[],['avenue','town','town','town','town']);
  const w=new World({...meadowScenario(),network,town:undefined,demand:[]},11);
  w.congestionAware=false;
  const [inner,outer]=network.avenuePairs![0]!;
  expect(w.routing.canReach(1,outer)).toBe(true);
  w.vehicles.spawn(inner,network.lanes[inner]!.length/2,3,1,0);
  const driver=w.vehicles.spawn(entries[0]!,0,3,1,0);
  let usedInner=false;
  for(let t=0;t<4000 && w.vehicles.alive[driver];t++) {
    w.step();
    expect(w.vehicles.lane[driver]).not.toBe(outer);
    usedInner ||= w.vehicles.lane[driver]===inner;
  }
  expect(usedInner).toBe(true);
  expect(w.stats().completed).toBe(2);
  expect(w.stats().lost).toBe(0);
});

it('leaves moving followers room to brake when two Avenue queues narrow into one', () => {
  const ends = [{x:0, y:0}, {x:250, y:0}];
  function street(type: 'avenue' | 'town') {
    const {network} = buildStreetNetwork(new NetworkBuilder(), [ends], ends, [], [type]);
    return {...meadowScenario(), town:undefined, network, demand:[]};
  }
  const avenue = street('avenue');
  const world = new World(avenue, 1);
  const [inner, outer] = avenue.network.avenuePairs![0]!;
  world.vehicles.spawn(inner, 100, 0, 1, 0);
  world.vehicles.spawn(outer, 100, 0, 1, 0);
  world.vehicles.spawn(inner, 83, 12, 1, 0);
  world.vehicles.spawn(inner, 61, 12, 1, 0);
  const edit = world.editNetwork(street('town'), undefined, true);
  if (!edit.ok) throw new Error(edit.reason);
  const v = edit.world.vehicles;
  for (let tick = 0; tick < 1600; tick++) {
    edit.world.step();
    for (let i = 0; i < v.highWater; i++) for (let j = 0; j < i; j++) {
      if (!v.alive[i] || !v.alive[j] || v.lane[i] !== v.lane[j]) continue;
      const leader = v.s[i]! > v.s[j]! ? i : j;
      if (Math.abs(v.s[i]! - v.s[j]!) < v.length[leader]! - 1e-4) throw new Error('Overlap after narrowing at tick ' + tick);
    }
  }
  expect(edit.world.stats().completed).toBe(4);
  expect(edit.world.stats().lost).toBe(0);
});
