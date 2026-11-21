// pnpm exec tsx scripts/grow.ts
import { serialize, writeHeapSnapshot } from 'node:v8';
import { plantValley, growTo } from './valley-layout';
import { frameMessage } from '../src/worker/frame';

const town = plantValley();
const { world } = town.session;
for (const target of [150, 500, 1000]) {
  const count = growTo(town, target);
  const times = [];
  let routingMs = 0;
  const refresh = world.routing.refresh;
  world.routing.refresh = function (tick, seconds) {
    const start = performance.now();
    refresh.call(this, tick, seconds);
    routingMs += performance.now() - start;
  };
  for (let i = 0; i < 1200; i++) {
    const start = performance.now();
    world.step();
    times.push(performance.now() - start);
  }
  world.routing.refresh = refresh;
  const stats = world.stats();
  if (stats.lost) throw new Error('Lost vehicle during sample');
  const mean = times.reduce((a, b) => a + b, 0) / times.length;
  const frame = frameMessage(world);
  console.log(
    JSON.stringify({
      target,
      homes: count,
      mean,
      p95: times.sort((a, b) => a - b)[1139],
      tps: 1000 / mean,
      required: [20, 80, 160],
      routingMsPerTick: routingMs / 1200,
      cars: stats.active,
      walkers: stats.walkers,
      lost: stats.lost,
      rssMiB: process.memoryUsage().rss / 1048576,
      frameBytes: serialize(frame).length,
      hash: world.hash(),
    }),
  );
  if (target === 1000 && process.env.VALLEY_HEAP_SNAPSHOT) {
    const before = process.memoryUsage();
    if (!global.gc) throw new Error('Use node --expose-gc --import tsx scripts/grow.ts');
    // Keep precisely the same roots live at both checkpoints.
    for (let pass = 0; pass < 3; pass++) {
      global.gc();
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
    const after = process.memoryUsage();
    const snapshot = writeHeapSnapshot(process.env.VALLEY_HEAP_SNAPSHOT);
    console.log(
      JSON.stringify({
        before,
        after,
        snapshot,
        edits: town.edits.length,
        frameBytes: serialize(frame).length,
        hash: world.hash(),
      }),
    );
  }
}
