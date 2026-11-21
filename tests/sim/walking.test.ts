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
  expect(walk.walkedTrips).toBeGreaterThan(0);
  expect(drive.walkedTrips).toBe(0);
  expect(drive.trips).toBeGreaterThan(walk.trips);
});
