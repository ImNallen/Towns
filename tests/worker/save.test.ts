import { expect, it } from 'vitest';
import { decodeCellKey, type CellKey } from '../../src/sim/zoning/cells';
import { createSession, replay, type Session } from '../../src/worker/session';
import { parseSave } from '../../src/worker/save';

function town() {
  return createSession({ scenario: 'meadow', seed: 1, walkLimit: 600 }, msg => {
    if (msg.type === 'editRejected') throw new Error(msg.reason);
  });
}

function roundTrip(session: Session) {
  const restored = replay(parseSave(JSON.stringify(session.save())));
  expect(restored.edits).toEqual(session.edits);
  expect(restored.world.tick).toBe(session.world.tick);
  expect(restored.world.hash()).toBe(session.world.hash());
  expect(restored.world.townView()).toEqual(session.world.townView());
  for (let i = 0; i < 37; i++) {
    restored.world.step();
    session.world.step();
  }
  expect(restored.world.hash()).toBe(session.world.hash());
}

it('restores a working mixed town with walking trips, parking and timed undo', () => {
  const session = town();
  const keys = Array.from(session.world.scenario.zones!.keys, raw => raw as CellKey);
  for (const [i, zone] of (['residential', 'shops', 'workplaces'] as const).entries()) {
    const cells = keys.filter(key => {
      const { column, side } = decodeCellKey(key);
      const band = (column + side * 2) % 6;
      return i === (band < 3 ? 0 : band === 3 ? 1 : 2);
    });
    session.command({ type: 'paintZone', zone, cells });
  }
  while (session.world.tick < 144000) session.world.step();
  expect(session.world.townView()!.parking.walkedTrips).toBeGreaterThan(0);
  session.command({ type: 'undo' });
  roundTrip(session);
});

it('restores a junction, actuated lights, and an avenue at distinct edit ticks', () => {
  const session = town();
  session.command({ type: 'buildRoad', start: { x: -65, y: -45 }, end: { x: -65, y: 62 } });
  session.world.step();
  session.command({ type: 'buildLights', point: { x: -65, y: -8 }, actuated: true });
  session.command({ type: 'upgradeRoad', segment: 0, editCount: 2, roadType: 'avenue' });
  while (session.world.tick < 2200) session.world.step();
  expect(session.edits).toHaveLength(3);
  roundTrip(session);
});

it('rejects incompatible versions and invalid edit histories', () => {
  const save = town().save();
  expect(() => parseSave(JSON.stringify({ ...save, version: 2 }))).toThrow(/version/);
  expect(() => parseSave(JSON.stringify({ ...save, events: [{ tick: 5, command: { type: 'undo' } }] }))).toThrow(/history/);
  expect(() => parseSave(JSON.stringify({ ...save, events: [{ tick: 0, command: { type: 'load' } }] }))).toThrow(/history/);
});

it('restores parking bays, a crossing, a footpath and a park', () => {
  const session = town();
  session.command({ type: 'paintZone', zone: 'parking', cells: [524388, 524396] as CellKey[] });
  session.command({ type: 'buildWalk', walk: 'zebra', start: { x: -110, y: -8 }, end: { x: -110, y: -8 } });
  session.command({ type: 'buildWalk', walk: 'footpath', start: { x: 48, y: 4 }, end: { x: 30, y: -14 } });
  session.command({ type: 'paintZone', zone: 'park', cells: [524404] as CellKey[] });
  expect(session.world.townView()!.bays.some(bay => bay.kind === 'lot')).toBe(true);
  while (session.world.tick < 3000) session.world.step();
  roundTrip(session);
});

it('restores a deferred bulldoze with admissions closed and then cancelled', () => {
  const session = createSession({ scenario: 'meadow', seed: 3 }, () => {});
  session.command({ type: 'buildRoad', start: { x: -45, y: -8 }, end: { x: 45, y: 8 } });
  while (session.world.tick < 1200) session.world.step();
  session.command({ type: 'bulldozeRoad', editCount: 1, segment: 0 });
  expect(session.pending).toBe(true);
  session.command({ type: 'retry' });
  roundTrip(session);
  session.command({ type: 'cancelRoadEdit' });
  expect(session.pending).toBe(false);
  roundTrip(session);
});
