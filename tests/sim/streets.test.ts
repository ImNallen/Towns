import { describe, expect, it } from 'vitest';
import { endOf, startOf } from '../../src/sim/math/polyline';
import { distance, type Vec2 } from '../../src/sim/math/vec';
import { NetworkBuilder } from '../../src/sim/network/builder';
import { buildStreetNetwork } from '../../src/sim/network/streets';
import type { Network } from '../../src/sim/network/types';
import type { Scenario } from '../../src/sim/scenarios/types';
import { Routing } from '../../src/sim/traffic/routing';
import { DT, World } from '../../src/sim/world';

const W = { x: -120, y: 0 };
const E = { x: 120, y: 0 };
const S = { x: 0, y: -100 };
const C = { x: 0, y: 0 };
const streets = [[W, C], [C, E], [S, C]];
function build(paths: readonly (readonly Vec2[])[] = streets, portals: readonly Vec2[] = [W, E]) {
  return buildStreetNetwork(new NetworkBuilder(), paths, portals);
}
function source(network: Network, p: Vec2): number {
  return network.sources.find((id) => distance(startOf(network.lanes[id]!.path), p) < 3)!;
}
function arrival(network: Network, p: Vec2): number {
  return network.lanes.find((lane) => lane.next.length === 0 && distance(endOf(lane.path), p) < 3)!.id;
}
function movement(network: Network, from: Vec2, to: Vec2): number {
  return network.lanes[source(network, from)]!.next.find((id) => network.lanes[id]!.next.includes(arrival(network, to)))!;
}
function scenario(network: Network): Scenario {
  return { name: 'streets', network, demand: [], bounds: { minX: -200, maxX: 200, minY: -200, maxY: 200 },
    decor: { houses: [], hills: [], lakes: [] } };
}

describe('street junctions', () => {
  it.each([false, true])('provides all six tangent T movements regardless of input direction/order (%s)', (reverse) => {
    const paths = reverse ? streets.map((path) => [...path].reverse()).reverse() : streets;
    const { network, demand } = build(paths);
    expect(network.lanes.filter((lane) => lane.kind === 'connector')).toHaveLength(6);
    expect(demand).toHaveLength(2);
    for (const from of [W, E, S]) for (const to of [W, E, S]) {
      if (from === to) continue;
      const id = movement(network, from, to);
      expect(id).toBeTypeOf('number');
      const lane = network.lanes[id]!;
      const a = endOf(network.lanes[lane.prev[0]!]!.path);
      const b = startOf(lane.path);
      const c = endOf(lane.path);
      const d = startOf(network.lanes[lane.next[0]!]!.path);
      expect(distance(a, b)).toBeLessThan(1e-8);
      expect(distance(c, d)).toBeLessThan(1e-8);
      expect(a.hx * b.hx + a.hy * b.hy).toBeGreaterThan(0.999999);
      expect(c.hx * d.hx + c.hy * d.hy).toBeGreaterThan(0.999999);
    }
    for (const surface of network.surfaces.filter((s) => s.style === 'twoWay')) {
      expect(distance(startOf(surface.centerline), C)).toBeGreaterThanOrEqual(10);
      expect(distance(endOf(surface.centerline), C)).toBeGreaterThanOrEqual(10);
    }
    expect(network.surfaces.filter((s) => s.style === 'junction')).toHaveLength(6);
  });

  it('creates demand only between connected portals and excludes unfinished branch destinations', () => {
    const disconnected = build([[W, { x: -40, y: 0 }], [E, { x: 40, y: 0 }]]);
    expect(disconnected.demand).toEqual([]);
    const { network, demand } = build();
    expect(network.sinks).toEqual([arrival(network, W), arrival(network, E)]);
    expect(demand.map((d) => d.lane)).toEqual([source(network, W), source(network, E)]);
    expect(network.sinks).not.toContain(arrival(network, S));
  });

  it('drives each of the six complete movements to its intended exit', () => {
    for (const from of [W, E, S]) for (const to of [W, E, S]) {
      if (from === to) continue;
      const { network } = build(streets, [from, to]);
      const world = new World(scenario(network), 1);
      const dest = network.sinks.indexOf(arrival(network, to));
      const turn = movement(network, from, to);
      const slot = world.vehicles.spawn(source(network, from), 0, 8, dest, 0);
      let entered = false;
      for (let tick = 0; tick < 70 / DT; tick++) {
        world.step();
        if (world.vehicles.alive[slot] && world.vehicles.lane[slot] === turn) entered = true;
      }
      expect(entered).toBe(true);
      expect(world.stats().completed).toBe(1);
      expect(world.stats().lost).toBe(0);
    }
  });

  it('gives side traffic priority conflicts for crossings as well as merges', () => {
    const { network } = build();
    const left = network.lanes[movement(network, S, W)]!;
    const crossing = movement(network, W, E);
    expect(left.crossingYieldTo).toContain(crossing);
    expect(left.next).not.toEqual(network.lanes[crossing]!.next);
    expect(network.lanes[movement(network, S, E)]!.crossingYieldTo).toContain(crossing);
    expect(network.lanes[crossing]!.crossingYieldTo).toEqual([]);
  });

  it('waits before the mouth for crossing main-road traffic, then completes the turn', () => {
    const { network } = build();
    const world = new World(scenario(network), 1);
    const sideLane = source(network, S);
    const mainLane = source(network, W);
    const sideTurn = movement(network, S, W);
    const mainTurn = movement(network, W, E);
    const westDest = network.sinks.indexOf(arrival(network, W));
    const eastDest = network.sinks.indexOf(arrival(network, E));
    const side = world.vehicles.spawn(sideLane, network.lanes[sideLane]!.length - 12, 4, westDest, 0);
    const main = world.vehicles.spawn(mainLane, network.lanes[mainLane]!.length - 20, 8, eastDest, 0);
    let waited = false;
    let mainCleared = false;
    let sideEntered = false;
    for (let tick = 0; tick < 60 / DT; tick++) {
      world.step();
      const V = world.vehicles;
      if (V.lane[main] === mainTurn) mainCleared = false;
      if (V.lane[main] === arrival(network, E)) mainCleared = true;
      if (V.alive[side] && V.lane[side] === sideLane && V.v[side]! < 0.5) waited = true;
      if (V.alive[side] && V.lane[side] === sideTurn) { expect(mainCleared).toBe(true); sideEntered = true; }
    }
    expect(waited).toBe(true);
    expect(sideEntered).toBe(true);
    expect(world.stats().completed).toBe(2);
    expect(world.stats().lost).toBe(0);
  });

  it('lets a car already committed to a side turn clear before through traffic enters', () => {
    const { network } = build();
    const world = new World(scenario(network), 7);
    const { vehicles } = world;
    const turn = movement(network, S, W);
    const main = source(network, W);
    const sideCar = vehicles.spawn(turn, 1, 1, network.sinks.indexOf(arrival(network, W)), 0);
    const throughCar = vehicles.spawn(main, network.lanes[main]!.length - 9, 5, network.sinks.indexOf(arrival(network, E)), 0);
    for (let tick = 0; tick < 60 / DT; tick++) {
      world.step();
      if (vehicles.lane[sideCar] === turn) expect(vehicles.lane[throughCar]).toBe(main);
    }
    expect(world.stats().completed).toBe(2);
  });

  it('routes and actually drives the faster bypass between two T junctions', () => {
    const a = { x: -50, y: 0 };
    const b = { x: 50, y: 0 };
    const detour = [a, { x: -35, y: 0 }, { x: -20, y: 95 }, { x: 20, y: 95 }, { x: 35, y: 0 }, b];
    const bypass = [a, { x: -50, y: -15 }, { x: 0, y: -25 }, { x: 50, y: -15 }, b];
    const base = build([[W, a], detour, [b, E]]);
    const { network } = build([[W, a], detour, [b, E], bypass]);
    const routing = new Routing(network);
    const from = source(network, W);
    const dest = network.sinks.indexOf(arrival(network, E));
    const baseline = new Routing(base.network);
    expect(routing.travelTime(dest, from)).toBeLessThan(baseline.travelTime(1, source(base.network, W)));
    const bypassLane = network.lanes.find((l) => l.kind === 'road' && startOf(l.path).y < -9 && endOf(l.path).y < -9 && startOf(l.path).x < 0)!;
    expect(bypassLane).toBeDefined();
    const route: number[] = [];
    let lane = from;
    while (lane >= 0) { route.push(lane); lane = routing.nextHop(dest, lane); }
    expect(route).toContain(bypassLane.id);
    const world = new World(scenario(network), 2);
    const slot = world.vehicles.spawn(from, 0, 8, dest, 0);
    const trace = new Set<number>();
    for (let t = 0; t < 90 / DT; t++) {
      if (world.vehicles.alive[slot]) trace.add(world.vehicles.lane[slot]!);
      world.step();
    }
    expect(trace.has(bypassLane.id)).toBe(true);
    expect(world.stats().completed).toBe(1);
    expect(world.stats().lost).toBe(0);
  });
});
