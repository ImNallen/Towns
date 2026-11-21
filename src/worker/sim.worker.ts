import { DT, type World } from '../sim/world';
import { createSession, CAPACITY, replay, type Session } from './session';
import { parseSave } from './save';
import type { FromWorker, ToWorker } from './protocol';

/** Cap catch-up work per pump so a slow frame cannot snowball. */
const MAX_STEPS_PER_PUMP = 40;
/** Wall-clock ms between town views. */
const TOWN_INTERVAL = 250;

let session: Session;
let loading: AbortController | null = null;
let speed = 1;
let accumulator = 0;
let last = performance.now();
let lastTown = -Infinity;

const post = (msg: FromWorker, transfer: Transferable[] = []): void => self.postMessage(msg, { transfer });

function notify(msg: FromWorker): void {
  if (msg.type === 'zoningChanged') {
    postTown(session.world);
    postFrame(session.world);
  }
  post(msg);
  if (msg.type === 'roadsChanged') {
    postFrame(session.world);
    postTown(session.world);
  }
}

function ready(): void {
  accumulator = 0;
  last = performance.now();
  post({ type: 'ready', scenario: session.world.scenario, capacity: CAPACITY, edits: session.edits });
  if (session.pending) post({ type: 'editWaiting' });
  postFrame(session.world);
  postTown(session.world);
}

self.onmessage = async (e: MessageEvent<ToWorker>) => {
  const msg = e.data;
  switch (msg.type) {
    case 'init':
      session = createSession({ scenario: msg.scenario, seed: msg.seed, walkLimit: msg.walkLimit }, notify);
      speed = msg.speed;
      ready();
      break;
    case 'cancelLoad':
      loading?.abort(new Error('Load cancelled.'));
      break;
    case 'load': {
      loading?.abort(new Error('Another town was opened.'));
      const controller = new AbortController();
      loading = controller;
      try {
        session = await replay(parseSave(msg.json), notify, controller.signal);
        ready();
        post({ type: 'loaded', id: msg.id });
      } catch (error) {
        last = performance.now();
        post({ type: 'loadError', id: msg.id, reason: error instanceof Error ? error.message : 'Invalid save.' });
      } finally {
        if (loading === controller) loading = null;
      }
      break;
    }
    case 'save':
      post({ type: 'saved', id: msg.id, json: JSON.stringify(session.save()) });
      break;
    case 'setSpeed':
      speed = msg.speed;
      break;
    default:
      if (loading) post({ type: 'editRejected', reason: 'Wait for the town to load.' });
      else session.command(msg);
  }
};

function postFrame(w: World): void {
  const positions = new Float32Array(w.vehicles.highWater * 3);
  const ids = new Int32Array(w.vehicles.highWater);
  const models = new Uint8Array(w.vehicles.highWater);
  const paint = new Uint8Array(w.vehicles.highWater);
  const slots = w.writeSnapshot(positions, ids, models, paint);
  const walkers = w.pedestrianPositions();
  post({ type: 'frame', signalClocks: w.signalClocks, walkers, traffic: w.traffic.view(), tick: w.tick, slots, positions, ids, models, paint, stats: w.stats() }, [walkers.buffer, positions.buffer, ids.buffer, models.buffer, paint.buffer]);
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
  if (loading || !session || speed <= 0) return;
  const world = session.world;
  accumulator += elapsed * speed;
  let steps = 0;
  while (accumulator >= DT && steps < MAX_STEPS_PER_PUMP) {
    world.step();
    accumulator -= DT;
    steps++;
  }
  if (steps === MAX_STEPS_PER_PUMP) accumulator = 0; // falling behind: drop time rather than spiral
  if (steps > 0) {
    if (session.pending && (world.vehicles.count === 0 || Math.floor(world.tick / 20) !== Math.floor((world.tick - steps) / 20))) {
      session.command({ type: 'retry' });
      if (!session.pending) return;
    }
    postFrame(world);
    if (now - lastTown >= TOWN_INTERVAL) postTown(world);
  }
}, 1000 / 60);
