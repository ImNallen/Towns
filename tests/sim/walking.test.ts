import { WalkRouting } from '../../src/sim/network/walkRouting';
import { walkChance } from '../../src/sim/town/mode';
import { expect, it } from 'vitest';
import { polyline } from '../../src/sim/math/polyline';
import { NetworkBuilder } from '../../src/sim/network/builder';
import { buildStreetNetwork } from '../../src/sim/network/streets';
import { WalkingNetwork, Walkers, WALK_EDIT_SNAP_METRES } from '../../src/sim/network/walking';
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

it('resumes a mid-pavement trip at the nearest reachable point within the edit radius', () => {
  const graphAt = (y: number) => {
    const alignment = street.map(line => line.map(p => ({ x: p.x, y: p.y + y })));
    return new WalkingNetwork(buildStreetNetwork(new NetworkBuilder(), alignment, []).network, doors, []);
  };
  const old = new Walkers(graphAt(0), 1);
  old.start(0, 0, 1, 30);
  for (let t = 0; t < 500; t++) old.step(0.05);
  const [x, y] = old.positions();
  const shifted = new Walkers(graphAt(WALK_EDIT_SNAP_METRES), 1);
  expect(shifted.restore(0, old, 1)).toBe(true);
  expect(shifted.positions()[0]).toBeCloseTo(x!);
  expect(shifted.positions()[1]).toBeCloseTo(y! + WALK_EDIT_SNAP_METRES);
  for (let t = 0; t < 2000 && shifted.count; t++) shifted.step(0.05);
  expect(shifted.count).toBe(0);
  expect(shifted.node[0]).toBe(shifted.graph.places[1]);
  expect(new Walkers(graphAt(WALK_EDIT_SNAP_METRES + 0.1), 1).restore(0, old, 1)).toBe(false);
});

it('stays on its segment when a new shortcut changes both endpoint routes', () => {
  const a = { x: 0, y: 0 }, b = { x: 20, y: 0 }, door = { x: 10, y: 10 };
  const graph = (lines: typeof a[][]) => new WalkingNetwork({
    lanes: [], sinks: [], sources: [],
    surfaces: lines.map((points, id) => ({ id, style: 'footpath', width: 2, centerline: polyline(points) })),
  }, [a, door], []);
  const before = new Walkers(graph([[a, b], [b, door]]), 1);
  before.start(0, 0, 1, 30);
  before.step(12);
  const changed = graph([[a, b], [b, door], [a, door]]);
  const snapped = new Walkers(changed, 1);
  expect(snapped.restore(0, before, 1)).toBe(true);
  expect(snapped.positions()).toEqual(before.positions());
  snapped.step(1);
  const again = new Walkers(changed, 1);
  expect(again.restore(0, snapped, 1)).toBe(true);
  expect(again.positions()).toEqual(snapped.positions());
  expect(again.positions()[0]).toBeGreaterThan(before.positions()[0]!);
  for (let t = 0; t < 1000 && again.count; t++) again.step(0.05);
  expect(again.node[0]).toBe(changed.places[1]);
  expect(again.count).toBe(0);
});

it('applies a road upgrade during a walk and counts trips cleared by pavement removal', () => {
  const scenario = meadowScenario();
  const world = new World(scenario, 1);
  const zoning = new Map(Array.from(scenario.zones!.keys, raw => {
    const key = raw as CellKey, { column, side } = decodeCellKey(key);
    const band = (column + 2 * side) % 6;
    return [key, band < 3 ? 'residential' : band === 3 ? 'shops' : 'workplaces'] as const;
  }));
  world.setZoning(zoning);
  const upgrade = meadowScenario([{ upgrade: 1, roadType: 'parking' }]);
  const removal = meadowScenario([{ upgrade: 1, roadType: 'country' }]);
  for (let t = 0; t < 30501; t++) world.step();
  const before = world.walkers!.positions();
  const upgraded = world.editNetwork(upgrade);
  if (!upgraded.ok) throw new Error(upgraded.reason);
  const after = upgraded.world.walkers!.positions();
  expect(upgraded.world.tick).toBe(world.tick);
  expect(upgraded.world.stats()).toMatchObject({ walkersCleared: 0, lost: 0 });
  expect(after.length).toBe(before.length);
  const distances = [];
  for (let i = 0; i < after.length; i += 3) {
    expect(after[i + 2]).toBe(before[i + 2]);
    distances.push(Math.hypot(after[i]! - before[i]!, after[i + 1]! - before[i + 1]!));
  }
  expect(Math.max(...distances)).toBeGreaterThan(1);
  expect(Math.max(...distances)).toBeLessThanOrEqual(WALK_EDIT_SNAP_METRES);
  const removed = world.editNetwork(removal);
  if (!removed.ok) throw new Error(removed.reason);
  const stats = removed.world.stats();
  expect(stats.walkersCleared).toBeGreaterThan(0);
  expect(stats.walkers + stats.walkersCleared).toBe(world.walkers!.count);
  for (const [scenario, edited] of [[upgrade, upgraded.world], [removal, removed.world]] as const) {
    const replay = world.editNetwork(scenario);
    if (!replay.ok) throw new Error(replay.reason);
    for (let i = 0; i < 2400; i++) {
      edited.step();
      replay.world.step();
    }
    expect(replay.world.hash()).toBe(edited.hash());
    expect(edited.stats().lost).toBe(0);
  }
  expect(removed.world.stats().walkersCleared).toBe(stats.walkersCleared);
});

it('repairs routes around changed pavement and preserves cold-build routing ties', () => {
  const original = buildStreetNetwork(new NetworkBuilder(),street,[]).network;
  const graph = new WalkingNetwork(original,doors,[]);
  const changed = buildStreetNetwork(new NetworkBuilder(),street,[],[],['parking']).network;
  const edited = new WalkingNetwork(changed,doors,[],graph.routing);
  const cold = new WalkingNetwork(changed,doors,[]);
  expect(edited.costs).toEqual(cold.costs);
  expect(edited.next).toEqual(cold.next);
  const removed = buildStreetNetwork(new NetworkBuilder(),street,[],[],['country']).network;
  expect(new WalkingNetwork(removed,doors,[],edited.routing).distance(0,1)).toBe(Infinity);
});

it('retains the cold walking routes when an edit cuts, replaces and adds frontage', () => {
  const original = buildStreetNetwork(new NetworkBuilder(), street, []).network;
  const graph = new WalkingNetwork(original, doors, []);
  const extended = buildStreetNetwork(new NetworkBuilder(), [
    [{ x:0,y:0 },{ x:60,y:0 }],
    [{ x:60,y:0 },{ x:110,y:0 }],
    [{ x:60,y:0 },{ x:60,y:40 }],
  ], []).network;
  const places = [doors[1]!,{x:63,y:30},doors[0]!];
  const cold = new WalkingNetwork(extended,places,[]);
  const edited = new WalkingNetwork(extended,places,[],graph.routing);
  expect(edited.costs).toEqual(cold.costs);
  expect(edited.next).toEqual(cold.next);
});

it.each([32768, 32769])('routes to the highest node with %i walking nodes', (count) => {
  const target = count - 1;
  const points = Array.from({ length: count }, (_, x) => ({ x, y: 0 }));
  const edges = points.map((): { to: number; length: number }[] => []);
  edges[0]!.push({ to: target, length: 1 });
  edges[target]!.push({ to: 0, length: 1 });
  const routing = new WalkRouting(points, edges, [target]);
  expect(routing.next[0]![0]).toBe(target);
  expect(routing.next[0]![1]).toBe(-1);
  expect(routing.next[0]![target]).toBe(-1);
  expect(routing.next[0]!.byteLength).toBe(count * (count === 32768 ? 2 : 4));
});

it('keeps routes independent across hundreds of destinations', () => {
  const points = Array.from({ length: 1024 }, (_, x) => ({ x, y: 0 }));
  const edges = points.map((_, i) =>
    [i - 1, i + 1].filter((j) => j >= 0 && j < points.length).map((to) => ({ to, length: 1 })),
  );
  const targets = Array.from({ length: 520 }, (_, i) => i);
  const routing = new WalkRouting(points, edges, targets);
  for (const target of targets) {
    expect(routing.costs[target]![512]).toBe(Math.abs(512 - target));
    expect(routing.next[target]![512]).toBe(target === 512 ? -1 : target < 512 ? 511 : 513);
  }
});
