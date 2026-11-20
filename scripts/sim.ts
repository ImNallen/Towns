/**
 * Headless simulation runner.
 *
 *   pnpm sim                                   # roundabout, seed 1, 10 sim-minutes
 *   pnpm sim --scenario straight --ticks 2400 --seed 7 --every 1200
 *   pnpm sim --json                            # machine-readable summary only
 */
import { parseArgs } from 'node:util';
import { buildScenario, isScenarioName, SCENARIOS } from '../src/sim/scenarios';
import { DT, World, type SimStats } from '../src/sim/world';

const { values } = parseArgs({
  args: process.argv.slice(2).filter((a) => a !== '--'),
  options: {
    scenario: { type: 'string', default: 'roundabout' },
    ticks: { type: 'string', default: String(10 * 60 * 20) },
    seed: { type: 'string', default: '1' },
    every: { type: 'string', default: '0' },
    json: { type: 'boolean', default: false },
  },
});

const scenarioName = values.scenario;
if (!isScenarioName(scenarioName)) {
  console.error(`unknown scenario "${scenarioName}". Available: ${Object.keys(SCENARIOS).join(', ')}`);
  process.exit(1);
}
const ticks = Number(values.ticks);
const seed = Number(values.seed);
const every = Number(values.every);

const fmt = (st: SimStats): string =>
  [
    `t=${st.time.toFixed(0).padStart(5)}s`,
    `active=${String(st.active).padStart(4)}`,
    `done=${String(st.completed).padStart(5)}`,
    `per-min=${String(st.completedLastMinute).padStart(3)}`,
    `speed=${st.meanSpeed.toFixed(1).padStart(4)}m/s`,
    `stopped=${(st.stoppedShare * 100).toFixed(0).padStart(3)}%`,
    `trip=${st.meanTripTime.toFixed(1)}s`,
    `lost=${st.lost}`,
  ].join('  ');

const world = new World(buildScenario(scenarioName), seed);
const started = performance.now();
for (let t = 0; t < ticks; t++) {
  world.step();
  if (!values.json && every > 0 && world.tick % every === 0) console.log(fmt(world.stats()));
}
const elapsedMs = performance.now() - started;

const summary = {
  scenario: scenarioName,
  seed,
  ticks,
  simSeconds: ticks * DT,
  hash: world.hash(),
  msPerTick: Number((elapsedMs / ticks).toFixed(4)),
  stats: world.stats(),
};

if (values.json) {
  console.log(JSON.stringify(summary, null, 2));
} else {
  console.log(`\n${scenarioName} seed=${seed}: ${fmt(summary.stats)}`);
  console.log(`hash=${summary.hash}  ${summary.msPerTick}ms/tick  (${(elapsedMs / 1000).toFixed(2)}s wall)`);
}
