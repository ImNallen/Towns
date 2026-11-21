/**
 * Owns the World and advances it on a fixed tick, independent of the frame rate.
 * Posts a compact snapshot whenever the simulation has advanced.
 */
import { buildScenario, type Scenario } from '../sim/scenarios';
import { planWalk, isZoneStroke, meadowScenario, meadowSegments, upgradeFailure, meadowZoning, planMeadowRoad, type MeadowEdit } from '../sim/scenarios/meadow';
import { planZoneStroke } from '../sim/zoning/paint';
import { editCost, shortage, undoCost } from '../sim/town/budget';
import { DT, World } from '../sim/world';
import type { FromWorker, ToWorker } from './protocol';

const CAPACITY = 4096;
/** Cap catch-up work per pump so a slow frame cannot snowball. */
const MAX_STEPS_PER_PUMP = 40;
/** Wall-clock ms between town views. */
const TOWN_INTERVAL = 250;

let edits: MeadowEdit[] = [];
type RoadChange = { edits: MeadowEdit[]; scenario: Scenario; cost: number };
let waiting: RoadChange | null = null;
let world: World | null = null;
let speed = 1;
let accumulator = 0;
let last = performance.now();
let lastTown = -Infinity;

const post = (msg: FromWorker, transfer: Transferable[] = []): void => self.postMessage(msg, { transfer });

self.onmessage = (e: MessageEvent<ToWorker>) => {
  const msg = e.data;
  switch (msg.type) {
    case 'init': {
      const scenario = buildScenario(msg.scenario);
      edits = [];
      waiting = null;
      world = new World(scenario, msg.seed, CAPACITY, 0, msg.walkLimit);
      speed = msg.speed;
      accumulator = 0;
      last = performance.now();
      post({ type: 'ready', scenario, capacity: CAPACITY });
      postFrame(world);
      postTown(world);
      break;
    }
    case 'upgradeRoad':
    case 'bulldozeRoad':
    case 'buildWalk':
    case 'buildRoad':
    case 'undo': {
      if (world?.scenario.name !== 'meadow') {
        post({ type: 'editRejected', reason: 'Open Meadow Vale to build a road.' });
        break;
      }
      if (waiting) break;
      let proposed: MeadowEdit[];
      if (msg.type === 'buildWalk') {
        const cells = world.scenario.zones!;
        const plan = planWalk(world.network, msg.walk, msg.start, msg.end, { cells, zoning: meadowZoning(edits,cells) });
        if (typeof plan === 'string') { post({ type: 'editRejected', reason: plan }); break; }
        proposed = [...edits,plan];
      } else if (msg.type === 'buildRoad') {
        const plan = planMeadowRoad(edits, msg.start, msg.end, msg.bend, msg.roadType);
        if (!plan.ok) {
          post({ type: 'editRejected', reason: plan.reason });
          break;
        }
        proposed = [...edits, plan.road];
      } else if (msg.type === 'bulldozeRoad' || msg.type === 'upgradeRoad') {
        if (msg.editCount !== edits.length || !Number.isInteger(msg.segment) || (msg.type === 'bulldozeRoad' && !meadowSegments(edits)[msg.segment])) {
          post({ type: 'editRejected', reason: 'Select a street segment.' });
          break;
        }
        const reason = msg.type === 'upgradeRoad' && upgradeFailure(edits, msg.segment, msg.roadType);
        if (reason) {
          post({ type: 'editRejected', reason });
          break;
        }
        proposed = [...edits, msg.type === 'upgradeRoad' ? { upgrade: msg.segment, roadType: msg.roadType } : { remove: msg.segment }];
      } else if (edits.length && isZoneStroke(edits.at(-1)!)) {
        const next = edits.slice(0, -1);
        commitZoning(next, undoCost(edits));
        break;
      } else {
        proposed = edits.slice(0, -1);
      }
      if (!edits.length && msg.type === 'undo') break;
      const cost = msg.type === 'undo' ? undoCost(edits) : editCost(edits, proposed.at(-1)!);
      const edit = { edits: proposed, scenario: meadowScenario(proposed), cost };
      if (!applyEdit(edit)) {
        waiting = edit;
        world.setAdmissions(false);
        post({ type: 'editWaiting' });
      }
      break;
    }
    case 'paintZone': {
      const cells = world?.scenario.name === 'meadow' ? world.scenario.zones : undefined;
      if (!cells) {
        post({ type: 'editRejected', reason: 'Open Meadow Vale to zone plots.' });
        break;
      }
      if (waiting) break;
      const plan = planZoneStroke(cells, meadowZoning(edits, cells), msg.zone, msg.cells);
      if (plan.ok) commitZoning([...edits, plan.stroke], editCost(edits, plan.stroke));
      else post({ type: 'editRejected', reason: plan.reason });
      break;
    }
    case 'cancelRoadEdit':
      if (waiting) {
        waiting = null;
        world?.setAdmissions(true);
        post({ type: 'editRejected', reason: 'Edit cancelled.' });
      }
      break;
    case 'setSpeed':
      speed = msg.speed;
      break;
  }
};

function rejectShortage(reason: string | undefined): boolean {
  if (!reason) return false;
  waiting = null;
  world!.setAdmissions(true);
  post({ type: 'editRejected', reason });
  return true;
}

function commitZoning(next: MeadowEdit[], cost: number): void {
  if (world?.scenario.zones) {
    if (rejectShortage(world.treasury!.book(cost))) return;
    world.setZoning(meadowZoning(next, world.scenario.zones));
    postTown(world);
    postFrame(world);
  }
  edits = next;
  post({ type: 'zoningChanged', edits });
}

function applyEdit(edit: RoadChange): boolean {
  if (!world) return false;
  if (rejectShortage(shortage(world.treasury!.balance, edit.cost))) return true;
  const result = world.editNetwork(edit.scenario, meadowZoning(edit.edits, edit.scenario.zones!));
  if (!result.ok) return false;
  if (rejectShortage(result.world.treasury!.book(edit.cost))) return true;
  world = result.world;
  world.setAdmissions(true);
  edits = edit.edits;
  waiting = null;
  post({ type: 'roadsChanged', network: edit.scenario.network, zones: edit.scenario.zones, edits });
  postFrame(world);
  postTown(world);
  return true;
}

function postFrame(w: World): void {
  const positions = new Float32Array(w.vehicles.highWater * 3);
  const ids = new Int32Array(w.vehicles.highWater);
  const models = new Uint8Array(w.vehicles.highWater);
  const paint = new Uint8Array(w.vehicles.highWater);
  const slots = w.writeSnapshot(positions, ids, models, paint);
  const walkers = w.pedestrianPositions();
  post({ type: 'frame', walkers, tick: w.tick, slots, positions, ids, models, paint, stats: w.stats() }, [walkers.buffer, positions.buffer, ids.buffer, models.buffer, paint.buffer]);
}

function postTown(w: World): void {
  const view = w.townView();
  if (!view) return;
  lastTown = performance.now();
  post({ type: 'town', view });
}

setInterval(() => {
  const now = performance.now();
  const elapsed = Math.min((now - last) / 1000, 0.25);
  last = now;
  if (!world || speed <= 0) return;
  accumulator += elapsed * speed;
  let steps = 0;
  while (accumulator >= DT && steps < MAX_STEPS_PER_PUMP) {
    world.step();
    accumulator -= DT;
    steps++;
  }
  if (steps === MAX_STEPS_PER_PUMP) accumulator = 0; // falling behind: drop time rather than spiral
  if (steps > 0) {
    if (waiting && (world.vehicles.count === 0 || Math.floor(world.tick / 20) !== Math.floor((world.tick - steps) / 20)) && applyEdit(waiting)) return;
    postFrame(world);
    if (now - lastTown >= TOWN_INTERVAL) postTown(world);
  }
}, 1000 / 60);
