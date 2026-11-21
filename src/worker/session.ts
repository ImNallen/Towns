import { buildScenario, type Scenario } from '../sim/scenarios';
import { editableScenario, isZoneStroke, meadowZoning, type MeadowEdit } from '../sim/scenarios/meadow';
import { planZoneStroke } from '../sim/zoning/paint';
import { editCost, shortage, undoCost } from '../sim/town/budget';
import { World } from '../sim/world';
import type { FromWorker } from './protocol';
import { SAVE_VERSION } from './save';
import type { EditCommand, ReplayEvent, TownSave, InitialTown, Checkpoint } from './save';

import { packWorld, unpackWorld } from './snapshot';

export const CHECKPOINT_INTERVAL = 6000;
export const CAPACITY = 4096;
export type Session = ReturnType<typeof createSession>;

export function createSession(initial: InitialTown, post: (msg: FromWorker) => void) {
  const map = editableScenario(initial.scenario);
  let edits: MeadowEdit[] = [];
  type RoadChange = { edits: MeadowEdit[]; scenario: Scenario; cost: number; allowLaneShift: boolean };
  let waiting: RoadChange | null = null;
  let world = new World(buildScenario(initial.scenario), initial.seed, CAPACITY, 0, initial.walkLimit);
  let events: ReplayEvent[] = [];
  let snapshot: Checkpoint | undefined;
  let capturing = false;
  let lastCaptureTick = 0;

  function apply(msg: EditCommand): void {
    switch (msg.type) {
      case 'upgradeRoad':
      case 'bulldozeRoad':
      case 'buildLights':
      case 'buildWalk':
      case 'buildRoad':
      case 'undo': {
        if (!map) {
          post({ type: 'editRejected', reason: 'Open a town map to build a road.' });
          break;
        }
        if (waiting) break;
        let proposed: MeadowEdit[];
        if (msg.type === 'buildLights') {
          const junction = world.network.junctions?.find(j => Math.hypot(j.point.x-msg.point.x,j.point.y-msg.point.y) < 12);
          if (!junction || junction.lights) {
            post({ type: 'editRejected', reason: junction ? 'This junction already has lights.' : 'Select a T or four-way junction.' });
            break;
          }
          proposed = [...edits, { lights: junction.point, actuated: msg.actuated }];
        } else if (msg.type === 'buildWalk') {
          const cells = world.scenario.zones!;
          const plan = map.planWalk(world.network, msg.walk, msg.start, msg.end, { cells, zoning: meadowZoning(edits,cells) });
          if (typeof plan === 'string') { post({ type: 'editRejected', reason: plan }); break; }
          proposed = [...edits,plan];
        } else if (msg.type === 'buildRoad') {
          const plan = map.planMeadowRoad(edits, msg.start, msg.end, msg.bend, msg.roadType);
          if (!plan.ok) {
            post({ type: 'editRejected', reason: plan.reason });
            break;
          }
          proposed = [...edits, plan.road];
        } else if (msg.type === 'bulldozeRoad' || msg.type === 'upgradeRoad') {
          if (msg.editCount !== edits.length || !Number.isInteger(msg.segment) || (msg.type === 'bulldozeRoad' && !map.meadowSegments(edits)[msg.segment])) {
            post({ type: 'editRejected', reason: 'Select a street segment.' });
            break;
          }
          const reason = msg.type === 'upgradeRoad' && map.upgradeFailure(edits, msg.segment, msg.roadType);
          if (reason) {
            post({ type: 'editRejected', reason });
            break;
          }
          proposed = [...edits, msg.type === 'upgradeRoad' ? { upgrade: msg.segment, roadType: msg.roadType } : { remove: msg.segment }];
        } else if (edits.length && isZoneStroke(edits.at(-1)!)) {
          const next = edits.slice(0, -1);
          commitZoning(next, undoCost(edits, map));
          break;
        } else {
          proposed = edits.slice(0, -1);
        }
        if (!edits.length && msg.type === 'undo') break;
        const cost = msg.type === 'undo' ? undoCost(edits, map) : editCost(edits, proposed.at(-1)!, map);
        const changed = (msg.type === 'undo' ? edits : proposed).at(-1)!;
        const edit = { allowLaneShift: 'upgrade' in changed, edits: proposed, scenario: map.meadowScenario(proposed), cost };
        if (!applyEdit(edit)) {
          waiting = edit;
          world.setAdmissions(false);
          post({ type: 'editWaiting' });
        }
        break;
      }
      case 'paintZone': {
        const cells = world.scenario.zones;
        if (!map || !cells) {
          post({ type: 'editRejected', reason: 'Open a town map to zone plots.' });
          break;
        }
        if (waiting) break;
        const plan = planZoneStroke(cells, meadowZoning(edits, cells), msg.zone, msg.cells);
        if (plan.ok) commitZoning([...edits, plan.stroke], editCost(edits, plan.stroke, map));
        else post({ type: 'editRejected', reason: plan.reason });
        break;
      }
      case 'cancelRoadEdit':
        if (waiting) {
          waiting = null;
          world.setAdmissions(true);
          post({ type: 'editRejected', reason: 'Edit cancelled.' });
        }
        break;
      case 'retry':
        if (waiting) applyEdit(waiting);
        break;
    }
  }
  function rejectShortage(reason: string | undefined): boolean {
    if (!reason) return false;
    waiting = null;
    world.setAdmissions(true);
    post({ type: 'editRejected', reason });
    return true;
  }

  function commitZoning(next: MeadowEdit[], cost: number): void {
    if (world.scenario.zones) {
      if (rejectShortage(world.treasury!.book(cost))) return;
      world.setZoning(meadowZoning(next, world.scenario.zones));
    }
    edits = next;
    post({ type: 'zoningChanged', edits });
  }

  function applyEdit(edit: RoadChange): boolean {
    if (rejectShortage(shortage(world.treasury!.balance, edit.cost))) return true;
    const result = world.editNetwork(edit.scenario, meadowZoning(edit.edits, edit.scenario.zones!), edit.allowLaneShift);
    if (!result.ok) return false;
    if (rejectShortage(result.world.treasury!.book(edit.cost))) return true;
    world = result.world;
    world.setAdmissions(true);
    edits = edit.edits;
    waiting = null;
    post({ type: 'roadsChanged', network: edit.scenario.network, zones: edit.scenario.zones, edits });
    return true;
  }
  return {
    get world() { return world; },
    get edits() { return edits; },
    get pending() { return waiting !== null; },
    command(command: EditCommand) {
      events.push({ tick: world.tick, command });
      apply(command);
    },
    checkpointDue() {
      return !waiting && !capturing && world.tick - lastCaptureTick >= CHECKPOINT_INTERVAL;
    },
    async checkpoint() {
      if (waiting || capturing) return;
      capturing = true;
      lastCaptureTick = world.tick;
      try {
        const header = { tick: world.tick, hash: world.hash(), eventCount: events.length, edits, parcels: world.parcelSlots() };
        snapshot = { ...header, state: await packWorld(world) };
      } finally {
        capturing = false;
      }
    },
    async restore(saved: Checkpoint, history: ReplayEvent[], signal?: AbortSignal) {
      edits = saved.edits;
      const scenario = map && edits.length ? map.meadowScenario(edits) : buildScenario(initial.scenario);
      world = new World(scenario, initial.seed, CAPACITY, saved.tick, initial.walkLimit);
      world.restoreParcelSlots(saved.parcels, scenario.zones ? meadowZoning(edits, scenario.zones) : new Map());
      await unpackWorld(world, saved.state, signal);
      if (world.hash() !== saved.hash) throw new Error('Snapshot town hash mismatch.');
      snapshot = saved;
      lastCaptureTick = saved.tick;
      events = history.slice(0, saved.eventCount);
    },
    save(): TownSave {
      return { version: SAVE_VERSION, ...initial, tick: world.tick, events: events.slice(), snapshot };
    },
  };
}

export async function replay(save: TownSave, notify: (msg: FromWorker) => void = () => {}, signal?: AbortSignal): Promise<Session> {
  let live = false;
  const session = createSession({ scenario: save.scenario, seed: save.seed, walkLimit: save.walkLimit }, msg => { if (live) notify(msg); });
  const snapshot = save.version === SAVE_VERSION ? save.snapshot : undefined;
  if (snapshot) await session.restore(snapshot, save.events, signal);
  let nextYield = performance.now() + 40;
  let index = snapshot?.eventCount ?? 0;
  while (true) {
    const event = save.events[index];
    const until = event?.tick ?? save.tick;
    // Give the worker a chance to receive Cancel even for an imported, very distant tick.
    const end = Math.min(until, session.world.tick + 2048);
    while (session.world.tick < end) session.world.step();
    if (session.world.tick === until) {
      if (!event) break;
      session.command(event.command);
      index++;
    }
    if (performance.now() >= nextYield) {
      await new Promise(resolve => setTimeout(resolve, 0));
      signal?.throwIfAborted();
      nextYield = performance.now() + 40;
    }
  }
  live = true;
  return session;
}
