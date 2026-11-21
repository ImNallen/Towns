import { describe, expect, it } from 'vitest';
import { polyline } from '../../src/sim/math/polyline';
import { NetworkBuilder } from '../../src/sim/network/builder';
import type { Scenario } from '../../src/sim/scenarios/types';
import { World } from '../../src/sim/world';

function street(split = false, connected = true, rate = 0.5): Scenario {
  const b = new NetworkBuilder();
  const line = (x: number, end: number, y = 0) => b.addLane('road', polyline([{ x, y }, { x: end, y }]), 10);
  // Reorder all lane/destination indices when rebuilding, including the opposite direction.
  let reverse: number;
  let forward: number;
  if (split) {
    reverse = line(200, 0, 3.5);
    forward = line(0, 90);
    const middle = b.addLane('connector', polyline([{ x: 90, y: 0 }, { x: 110, y: 0 }]), 10);
    const exit = line(110, 200);
    if (connected) {
      b.connect(forward, middle);
      b.connect(middle, exit);
    }
    const branch = b.addLane('road', polyline([{ x: 100, y: -80 }, { x: 100, y: -10 }]), 10);
    b.addConnector(branch, exit, 6, 3.5);
  } else {
    forward = line(0, 200);
    reverse = line(200, 0, 3.5);
  }
  return {
    name: 'live-edit-test', network: b.build(),
    demand: [{ lane: forward, rate }, { lane: reverse, rate }],
    decor: { houses: [], lakes: [], hills: [] },
    bounds: { minX: 0, maxX: 200, minY: -80, maxY: 10 },
  };
}

function run(world: World, ticks: number): void {
  for (let i = 0; i < ticks; i++) world.step();
}

function snapshot(world: World): { positions: Float32Array; ids: Int32Array } {
  const positions = new Float32Array(world.vehicles.capacity * 3);
  const ids = new Int32Array(world.vehicles.capacity);
  world.writeSnapshot(positions, ids, new Uint8Array(world.vehicles.capacity));
  return { positions, ids };
}

function survivors(world: World): number[] {
  const V = world.vehicles;
  return Array.from(V.id.subarray(0, V.highWater)).filter((_, slot) => V.alive[slot]);
}

function edit(world: World, scenario: Scenario): World {
  const result = world.editNetwork(scenario);
  if (!result.ok) throw new Error(result.reason);
  return result.world;
}

describe('live network migration', () => {
  it('splits occupied lanes around a junction, remaps portal destinations and completes the same trips', () => {
    const original = new World(street(false, true, 0), 2);
    for (const s of [30, 85, 100, 115, 170]) original.vehicles.spawn(0, s, 8, 0, 0);
    original.vehicles.spawn(1, 30, 8, 1, 0);
    const before = snapshot(original);
    const migrated = edit(original, street(true, true, 0));
    expect(snapshot(migrated)).toEqual(before);
    expect(migrated.vehicles.id).toEqual(original.vehicles.id);
    expect(migrated.vehicles.v).toEqual(original.vehicles.v);
    expect(migrated.vehicles.departTime).toEqual(original.vehicles.departTime);
    expect(migrated.vehicles.dest[0]).toBe(1);
    expect(migrated.vehicles.dest[5]).toBe(0);
    expect(new Set(migrated.vehicles.lane.slice(0, 5)).size).toBe(3);
    expect(migrated.stats()).toEqual(original.stats());
    run(migrated, 1000);
    expect(migrated.stats().completed).toBe(6);
    expect(migrated.stats().active).toBe(0);
    expect(migrated.stats().lost).toBe(0);
    expect(snapshot(original)).toEqual(before);
  });

  it('reconnects split road lanes into a single lane without reversing or moving cars', () => {
    const split = new World(street(true, true, 0), 2);
    split.vehicles.spawn(1, 70, 8, 1, 0);
    split.vehicles.spawn(2, 10, 8, 1, 0);
    split.vehicles.spawn(3, 30, 8, 1, 0);
    const joined = edit(split, street(false, true, 0));
    expect(snapshot(joined)).toEqual(snapshot(split));
    expect(Array.from(joined.vehicles.s.slice(0, 3))).toEqual([70, 100, 140]);
    run(joined, 800);
    expect(joined.stats().completed).toBe(3);
    expect(joined.stats().lost).toBe(0);
  });

  it('retains time, cumulative and rolling statistics, random draws, and slot/id allocation', () => {
    const scenario = street();
    const original = new World(scenario, 123, 64);
    run(original, 1800);
    expect(original.stats().completed).toBeGreaterThan(0);
    const migrated = edit(original, scenario);
    expect(migrated.stats()).toEqual(original.stats());
    expect(migrated.vehicles.highWater).toBe(original.vehicles.highWater);
    expect(snapshot(migrated)).toEqual(snapshot(original));
    for (let i = 0; i < 600; i++) {
      original.step();
      migrated.step();
    }
    expect(migrated.hash()).toBe(original.hash());
    expect(migrated.stats()).toEqual(original.stats());
    expect(migrated.vehicles.id).toEqual(original.vehicles.id);
    expect(migrated.vehicles.acc).toEqual(original.vehicles.acc);
    expect(snapshot(migrated)).toEqual(snapshot(original));
  });

  it('clears only the cars a disconnected route strands and leaves the old world untouched', () => {
    const original = new World(street(false, true, 0), 4);
    const [west, middle, east, oncoming] = [40, 100, 150, 60].map((s, i) => original.vehicles.spawn(i < 3 ? 0 : 1, s, 8, i < 3 ? 0 : 1, 0));
    const before = snapshot(original);
    const disconnected = edit(original, street(true, false, 0));
    expect(survivors(disconnected)).toEqual([east, oncoming].map((slot) => original.vehicles.id[slot]));
    expect(disconnected.stats()).toMatchObject({ active: 2, cleared: 2, lost: 0 });
    expect(snapshot(original)).toEqual(before);
    expect(original.stats().cleared).toBe(0);
    expect([west, middle].every((slot) => original.vehicles.alive[slot])).toBe(true);
    run(disconnected, 600);
    expect(disconnected.stats()).toMatchObject({ completed: 2, active: 0, cleared: 2, lost: 0 });
    const reconnected = edit(disconnected, street(false, true, 0.5));
    expect(reconnected.stats().cleared).toBe(2);
    run(reconnected, 1200);
    expect(reconnected.stats().spawned).toBeGreaterThan(0);
    expect(reconnected.stats().completed).toBeGreaterThan(2);
    expect(reconnected.stats().lost).toBe(0);
  });

  it('clears a car whose curve moved away and never maps it onto an opposite-direction lane', () => {
    const original = new World(street(false, true, 0), 1);
    original.vehicles.spawn(0, 100, 8, 0, 0);
    const b = new NetworkBuilder();
    b.addLane('road', polyline([{ x: 0, y: 0 }, { x: 100, y: 6 }, { x: 200, y: 0 }]), 10);
    // An exact positional match faces backwards, and even has a route to the destination.
    const wrong = b.addLane('road', polyline([{ x: 110, y: 0 }, { x: 90, y: 0 }]), 10);
    const loop = b.addLane('connector', polyline([{ x: 90, y: 0 }, { x: 0, y: 0 }]), 10);
    b.connect(wrong, loop);
    b.connect(loop, 0);
    const edited = edit(original, { ...street(), network: b.build(), demand: [] });
    expect(edited.stats()).toMatchObject({ active: 0, cleared: 1, lost: 0 });
    expect(original.stats().active).toBe(1);
  });

  it('moves a car onto a lane reshaped within two metres and keeps its trip', () => {
    const original = new World(street(false, true, 0), 1);
    const car = original.vehicles.spawn(0, 100, 8, 0, 0);
    const b = new NetworkBuilder();
    const reshaped = b.addLane('road', polyline([{ x: 0, y: 0 }, { x: 100, y: 1.5 }, { x: 200, y: 0 }]), 10);
    b.addLane('road', polyline([{ x: 200, y: 3.5 }, { x: 0, y: 3.5 }]), 10);
    const edited = edit(original, { ...street(), network: b.build(), demand: [] });
    expect(edited.stats()).toMatchObject({ active: 1, cleared: 0 });
    expect(edited.vehicles.lane[car]).toBe(reshaped);
    const [before, after] = [original, edited].map((world) => snapshot(world).positions.slice(car * 3, car * 3 + 2));
    expect(Math.hypot(after![0]! - before![0]!, after![1]! - before![1]!)).toBeLessThan(1.5);
    run(edited, 600);
    expect(edited.stats()).toMatchObject({ completed: 1, lost: 0 });
  });

  it('clears the follower when a split puts two cars closer than a car length along a new route', () => {
    const original = new World(street(false, true, 0), 1);
    original.vehicles.spawn(0, 88, 0, 0, 0);
    const leader = original.vehicles.spawn(0, 91, 0, 0, 0);
    const edited = edit(original, street(true, true, 0));
    expect(survivors(edited)).toEqual([original.vehicles.id[leader]]);
    expect(edited.stats()).toMatchObject({ active: 1, cleared: 1 });
  });

  it('clears only the front of a queue of spacing conflicts', () => {
    const original = new World(street(false, true, 0), 1);
    const [back, , front] = [85, 88, 91].map((s) => original.vehicles.spawn(0, s, 0, 0, 0));
    const edited = edit(original, street(true, true, 0));
    expect(survivors(edited)).toEqual([back, front].map((slot) => original.vehicles.id[slot]));
    expect(edited.stats()).toMatchObject({ active: 2, cleared: 1 });
  });
});

it.each([[29.9, 0], [30.1, 1]])('applies the projection heading limit at %s degrees', (degrees, cleared) => {
  const original = new World(street(false, true, 0), 1);
  original.vehicles.spawn(0, 100, 8, 0, 0);
  const b = new NetworkBuilder();
  const rise = 20 * Math.tan(degrees * Math.PI / 180);
  b.addLane('road', polyline([
    { x: 80, y: -rise }, { x: 120, y: rise }, { x: 175, y: 0 }, { x: 200, y: 0 },
  ]), 10);
  const changed = edit(original, { ...street(), network: b.build(), demand: [] });
  expect(changed.stats()).toMatchObject({ active: 1 - cleared, cleared, lost: 0 });
});
