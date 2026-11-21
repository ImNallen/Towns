// pnpm exec tsx scripts/save-benchmark.ts
import { BUDGET } from '../src/sim/town/economy';
import { decodeCellKey, type CellKey } from '../src/sim/zoning/cells';
import { createSession, replay, type Session } from '../src/worker/session';
import { parseSave } from '../src/worker/save';
import { growTo, plantValley } from './valley-layout';

async function measure(session: Session) {
  // Leave one town hour of ticks after the checkpoint in every comparison.
  await session.checkpoint();
  for (let i = 0; i < 1200; i++) session.world.step();
  const saved = session.save();
  if (saved.version === 1 || !saved.snapshot) throw new Error('Missing benchmark checkpoint');
  const { snapshot, ...history } = saved;
  const files = [JSON.stringify({ ...history, version: 1 }), JSON.stringify(saved)];
  const hash = session.world.hash();
  const initial = BUDGET.startingBalance;
  try {
    // Mirror grow.ts's grant when replaying from tick zero. The game never receives this override.
    if (saved.scenario === 'valley') Object.assign(BUDGET, { startingBalance: initial + CAPITAL_GRANT });
    for (const json of files) {
      const ms: number[] = [];
      for (let i = 0; i < 3; i++) {
        const start = performance.now();
        const restored = await replay(parseSave(json));
        ms.push(Math.round(performance.now() - start));
        if (restored.world.hash() !== hash) throw new Error('Restored world diverged at ' + saved.tick);
      }
      console.log(JSON.stringify({ scenario: saved.scenario, tick: saved.tick, checkpoint: snapshot.tick,
        homes: session.world.townView()!.households.length, day: session.world.townView()!.day, hash,
        bytes: Buffer.byteLength(json), ms }));
    }
  } finally { Object.assign(BUDGET, { startingBalance: initial }); }
}

const meadow = createSession({ scenario: 'meadow', seed: 1 }, msg => {
  if (msg.type === 'editRejected') throw new Error(msg.reason);
});
meadow.command({ type: 'buildRoad', start: { x: -45, y: -8 }, end: { x: 45, y: 8 } });
const keys = Array.from(meadow.world.scenario.zones!.keys, k => k as CellKey);
for (const [index, zone] of (['residential', 'shops', 'workplaces'] as const).entries()) {
  meadow.command({ type: 'paintZone', zone, cells: keys.filter(k => {
    const { column, side } = decodeCellKey(k);
    const band = (column + side * 2) % 6;
    return index === (band < 3 ? 0 : band === 3 ? 1 : 2);
  }) });
}
while (meadow.world.tick < 288000 - 1200) meadow.world.step();
await measure(meadow);

const CAPITAL_GRANT = 200000;
const valley = plantValley(CAPITAL_GRANT);
growTo(valley, 150);
// Mature the first district before opening land for the two larger milestones.
while (valley.session.world.tick < 3 * 28800) valley.session.world.step();
for (const homes of [500, 1000]) {
  growTo(valley, homes);
  await measure(valley.session);
}
