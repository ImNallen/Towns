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

  it('rejects a disconnected route atomically and drains continuous demand before undo', () => {
    const scenario = street();
    const original = new World(scenario, 4);
    const control = new World(scenario, 4);
    run(original, 150);
    run(control, 150);
    const before = snapshot(original);
    const stats = original.stats();
    const disconnected = street(true, false);
    const result = original.editNetwork(disconnected);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain('Pause arrivals');
    expect(snapshot(original)).toEqual(before);
    expect(original.stats()).toEqual(stats);
    run(original, 20);
    run(control, 20);
    expect(original.hash()).toBe(control.hash());
    expect(snapshot(original)).toEqual(snapshot(control));
    original.setAdmissions(false);
    const spawned = original.stats().spawned;
    run(original, 1200);
    expect(original.stats().active).toBe(0);
    expect(original.stats().spawned).toBe(spawned);
    expect(original.stats().lost).toBe(0);
    const undone = edit(original, disconnected);
    expect(undone.stats()).toEqual(original.stats());
    run(undone, 100);
    expect(undone.stats().spawned).toBe(spawned);
    undone.setAdmissions(true);
    run(undone, 300);
    expect(undone.stats().spawned).toBeGreaterThan(spawned);
  });

  it('rejects changed curves and opposite-direction lanes instead of teleporting active cars', () => {
    const original = new World(street(false, true, 0), 1);
    original.vehicles.spawn(0, 100, 8, 0, 0);
    const before = snapshot(original);
    const b = new NetworkBuilder();
    b.addLane('road', polyline([{ x: 0, y: 0 }, { x: 100, y: 2 }, { x: 200, y: 0 }]), 10);
    // An exact positional match faces backwards, and even has a route to the destination.
    const wrong = b.addLane('road', polyline([{ x: 110, y: 0 }, { x: 90, y: 0 }]), 10);
    const loop = b.addLane('connector', polyline([{ x: 90, y: 0 }, { x: 0, y: 0 }]), 10);
    b.connect(wrong, loop);
    b.connect(loop, 0);
    expect(original.editNetwork({ ...street(), network: b.build(), demand: [] }).ok).toBe(false);
    expect(snapshot(original)).toEqual(before);
  });

  it('rejects a new route that overlaps cars across a split lane boundary', () => {
    const original = new World(street(false, true, 0), 1);
    original.vehicles.spawn(0, 88, 0, 0, 0);
    original.vehicles.spawn(0, 91, 0, 0, 0);
    expect(original.editNetwork(street(true, true, 0)).ok).toBe(false);
  });
});
