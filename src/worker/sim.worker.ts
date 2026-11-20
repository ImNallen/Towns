/**
 * Owns the World and advances it on a fixed tick, independent of the frame rate.
 * Posts a compact snapshot whenever the simulation has advanced.
 */
import { buildScenario, type Scenario } from '../sim/scenarios';
import { meadowScenario, planMeadowRoad, type MeadowRoad } from '../sim/scenarios/meadow';
import { DT, World } from '../sim/world';
import type { FromWorker, ToWorker } from './protocol';

const CAPACITY = 4096;
/** Cap catch-up work per pump so a slow frame cannot snowball. */
const MAX_STEPS_PER_PUMP = 40;

let roads: MeadowRoad[] = [];
let waiting: { roads: MeadowRoad[]; scenario: Scenario } | null = null;
let world: World | null = null;
let speed = 1;
let accumulator = 0;
let last = performance.now();

const post = (msg: FromWorker, transfer: Transferable[] = []): void => self.postMessage(msg, { transfer });

self.onmessage = (e: MessageEvent<ToWorker>) => {
  const msg = e.data;
  switch (msg.type) {
    case 'init': {
      const scenario = buildScenario(msg.scenario);
      roads = [];
      waiting = null;
      world = new World(scenario, msg.seed, CAPACITY);
      speed = msg.speed;
      accumulator = 0;
      last = performance.now();
      post({ type: 'ready', scenario, capacity: CAPACITY });
      postFrame(world);
      break;
    }
    case 'buildRoad':
    case 'undoRoad': {
      if (world?.scenario.name !== 'meadow') {
        post({ type: 'editRejected', reason: 'Open Meadow Vale to build a road.' });
        break;
      }
      if (waiting) break;
      let proposed: MeadowRoad[];
      if (msg.type === 'buildRoad') {
        const plan = planMeadowRoad(roads, msg.start, msg.end, msg.bend);
        if (!plan.ok) {
          post({ type: 'editRejected', reason: plan.reason });
          break;
        }
        proposed = [...roads, plan.road];
      } else {
        proposed = roads.slice(0, -1);
      }
      const edit = { roads: proposed, scenario: meadowScenario(proposed) };
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

function applyEdit(edit: { roads: MeadowRoad[]; scenario: Scenario }): boolean {
  if (!world) return false;
  const result = world.editNetwork(edit.scenario);
  if (!result.ok) return false;
  world = result.world;
  world.setAdmissions(true);
  roads = edit.roads;
  waiting = null;
  post({ type: 'roadsChanged', network: edit.scenario.network, roads });
  postFrame(world);
  return true;
}

function postFrame(w: World): void {
  const positions = new Float32Array(w.vehicles.highWater * 3);
  const ids = new Int32Array(w.vehicles.highWater);
  const slots = w.writeSnapshot(positions, ids);
  post({ type: 'frame', tick: w.tick, slots, positions, ids, stats: w.stats() }, [positions.buffer, ids.buffer]);
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
  }
}, 1000 / 60);
