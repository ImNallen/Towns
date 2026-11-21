import { walkChance } from '../../src/sim/town/mode';
import { expect, it } from 'vitest';
import { NetworkBuilder } from '../../src/sim/network/builder';
import { buildStreetNetwork } from '../../src/sim/network/streets';
import { WalkingNetwork, Walkers } from '../../src/sim/network/walking';
import { meadowScenario } from '../../src/sim/scenarios/meadow';
import { World } from '../../src/sim/world';
import { decodeCellKey, type CellKey } from '../../src/sim/zoning/cells';

const doors = [
  { x: 10, y: 6 },
  { x: 90, y: 6 },
];
const street = [
  [
    { x: 0, y: 0 },
    { x: 100, y: 0 },
  ],
];

it('follows the frontage, slows in a crowd and stops at the door', () => {
  const { network } = buildStreetNetwork(new NetworkBuilder(), street, []);
  const graph = new WalkingNetwork(network, doors, []);
  expect(graph.distance(0, 1)).toBeCloseTo(83.5);
  const travel = (count: number) => {
    const walkers = new Walkers(graph, count);
    for (let i = 0; i < count; i++) walkers.start(i, 0, 1, 30);
    let ticks = 0;
    while (walkers.goal[0] === 1 && ticks++ < 4000) {
      const [x, y] = walkers.positions();
      expect(x === 10 || x === 90 || y === 4.25).toBe(true);
      walkers.step(0.05);
    }
    expect(walkers.node[0]).toBe(graph.places[1]);
    return ticks;
  };
  expect(travel(4)).toBeGreaterThan(travel(1));
  const lane = buildStreetNetwork(new NetworkBuilder(), street, [], [], ['country']);
  expect(new WalkingNetwork(lane.network, doors, []).distance(0, 1)).toBe(Infinity);
});

it('chooses walking by route length and replays a mixed town deterministically', () => {
  const scenario = meadowScenario();
  const zoning = new Map(
    Array.from(scenario.zones!.keys, (raw) => {
      const key = raw as CellKey;
      const { column, side } = decodeCellKey(key);
      const band = (column + side * 2) % 6;
      return [key, band < 3 ? 'residential' : band === 3 ? 'shops' : 'workplaces'] as const;
    }),
  );
  const run = (limit: number) => {
    const world = new World(scenario, 1, 4096, 0, limit);
    world.setZoning(zoning);
    for (let i = 0; i < 144000; i++) world.step();
    expect(world.stats().lost).toBe(0);
    return { hash: world.hash(), ...world.townView()!.parking };
  };
  const walk = run(600),
    drive = run(1);
  expect(walk).toEqual(run(600));
  expect(walk.trips).toBeGreaterThan(0);
  expect(walk.walkedTrips).toBeGreaterThan(0);
  expect(drive.walkedTrips).toBe(0);
  expect(drive.trips).toBeGreaterThan(walk.trips);
});

it('weighs route length, grocery loads, children, accessible cars and car ownership', () => {
  const chance = (metres: number) => walkChance(metres,600,false,false,false,false);
  expect(chance(150)).toBeGreaterThan(0.9);
  expect(chance(350)).toBeCloseTo(0.5);
  expect(chance(510)).toBeLessThan(0.1);
  expect(chance(601)).toBe(0);
  expect(walkChance(700,600,true,true,true,false)).toBe(1);
  expect(walkChance(Infinity,600,true,false,false,false)).toBe(0);
  for (const [shop,child,car] of [[true,false,false],[false,true,false],[false,false,true]] as const) {
    expect(walkChance(200,600,false,shop,child,car)).toBeLessThan(chance(200));
  }
});

it('defers a moved pavement until walkers clear the edited road', () => {
  const scenario=meadowScenario();
  const world=new World(scenario,1);
  const zoning=new Map(Array.from(scenario.zones!.keys,raw=>{
    const key=raw as CellKey,{column,side}=decodeCellKey(key);
    const band=(column+2*side)%6;
    return [key,band<3?'residential':band===3?'shops':'workplaces'] as const;
  }));
  world.setZoning(zoning);
  const upgraded=meadowScenario([{upgrade:1,roadType:'parking'}]);
  for (let t=0;t<100000;t++) {
    world.step();
    if(t%100 || !world.walkers!.count) continue;
    const result=world.editNetwork(upgraded);
    if(result.ok || !result.reason.includes('walking')) continue;
    const before=world.walkers!.count;
    expect(before).toBeGreaterThan(0);
    world.setAdmissions(false);
    for(let wait=0;wait<28800;wait++) {
      world.step();
      if(wait%20 || world.walkers!.count || world.vehicles.count) continue;
      expect(world.editNetwork(upgraded).ok).toBe(true);
      expect(world.stats().lost).toBe(0);
      return;
    }
    throw new Error('Active trips failed to drain');
  }
  throw new Error('Expected an active pavement to defer the edit');
});
