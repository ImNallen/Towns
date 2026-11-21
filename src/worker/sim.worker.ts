/**
 * Owns the World and advances it on a fixed tick, independent of the frame rate.
 * Posts a compact snapshot whenever the simulation has advanced.
 */
import { buildScenario, type Scenario } from '../sim/scenarios';
import { meadowScenario, meadowSegments, planMeadowRoad, type MeadowEdit } from '../sim/scenarios/meadow';
import { DT, World } from '../sim/world';
import type { FromWorker, ToWorker } from './protocol';

const CAPACITY = 4096;
/** Cap catch-up work per pump so a slow frame cannot snowball. */
const MAX_STEPS_PER_PUMP = 40;
/** Wall-clock ms between town views. */
const TOWN_INTERVAL = 250;

let edits: MeadowEdit[] = [];
let waiting: { edits: MeadowEdit[]; scenario: Scenario } | null = null;
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
      world = new World(scenario, msg.seed, CAPACITY);
      speed = msg.speed;
      accumulator = 0;
      last = performance.now();
      post({ type: 'ready', scenario, capacity: CAPACITY });
      postFrame(world);
      postTown(world);
      break;
    }
    case 'bulldozeRoad':
    case 'buildRoad':
    case 'undoRoad': {
      if (world?.scenario.name !== 'meadow') {
        post({ type: 'editRejected', reason: 'Open Meadow Vale to build a road.' });
        break;
      }
      if (waiting) break;
      let proposed: MeadowEdit[];
      if (msg.type === 'buildRoad') {
        const plan = planMeadowRoad(edits, msg.start, msg.end, msg.bend);
        if (!plan.ok) {
          post({ type: 'editRejected', reason: plan.reason });
          break;
        }
        proposed = [...edits, plan.road];
      } else if (msg.type === 'bulldozeRoad') {
        if (msg.editCount !== edits.length || !Number.isInteger(msg.segment) || !meadowSegments(edits)[msg.segment]) {
          post({ type: 'editRejected', reason: 'Select a street segment to remove.' });
          break;
        }
        proposed = [...edits, { remove: msg.segment }];
      } else {
        proposed = edits.slice(0, -1);
      }
      const edit = { edits: proposed, scenario: meadowScenario(proposed) };
      if (!applyEdit(edit)) {
        waiting = edit;
        world.setAdmissions(false);
        post({ type: 'editWaiting' });
      }
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

function applyEdit(edit: { edits: MeadowEdit[]; scenario: Scenario }): boolean {
  if (!world) return false;
  const result = world.editNetwork(edit.scenario);
  if (!result.ok) return false;
  world = result.world;
  world.setAdmissions(true);
  edits = edit.edits;
  waiting = null;
  post({ type: 'roadsChanged', network: edit.scenario.network, edits });
  postFrame(world);
  postTown(world);
  return true;
}

function postFrame(w: World): void {
  const positions = new Float32Array(w.vehicles.highWater * 3);
  const ids = new Int32Array(w.vehicles.highWater);
  const models = new Uint8Array(w.vehicles.highWater);
  const slots = w.writeSnapshot(positions, ids, models);
  post({ type: 'frame', tick: w.tick, slots, positions, ids, models, stats: w.stats() }, [positions.buffer, ids.buffer, models.buffer]);
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
