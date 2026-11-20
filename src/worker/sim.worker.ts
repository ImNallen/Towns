/**
 * Owns the World and advances it on a fixed tick, independent of the frame rate.
 * Posts a compact snapshot whenever the simulation has advanced.
 */
import { buildScenario } from '../sim/scenarios';
import { DT, World } from '../sim/world';
import type { FromWorker, ToWorker } from './protocol';

const CAPACITY = 4096;
/** Cap catch-up work per pump so a slow frame cannot snowball. */
const MAX_STEPS_PER_PUMP = 40;

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
      world = new World(scenario, msg.seed, CAPACITY);
      speed = msg.speed;
      accumulator = 0;
      last = performance.now();
      post({ type: 'ready', scenario, capacity: CAPACITY });
      postFrame(world);
      break;
    }
    case 'setSpeed':
      speed = msg.speed;
      break;
  }
};

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
  if (steps > 0) postFrame(world);
}, 1000 / 60);
