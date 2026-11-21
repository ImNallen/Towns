import type { World } from '../sim/world';
import type { FromWorker } from './protocol';

export function frameMessage(w: World): Extract<FromWorker, { type: 'frame' }> {
  const positions = new Float32Array(w.vehicles.highWater * 3);
  const ids = new Int32Array(w.vehicles.highWater);
  const models = new Uint8Array(w.vehicles.highWater);
  const paint = new Uint8Array(w.vehicles.highWater);
  const slots = w.writeSnapshot(positions, ids, models, paint);
  const walkers = w.pedestrianPositions();
  return { type: 'frame', signalClocks: w.signalClocks, walkers, traffic: w.traffic.view(), tick: w.tick, slots, positions, ids, models, paint, stats: w.stats() };
}
