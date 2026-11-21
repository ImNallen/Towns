/**
 * Headless simulation runner.
 *
 *   pnpm sim                                   # roundabout, seed 1, 10 sim-minutes
 *   pnpm sim --scenario straight --ticks 2400 --seed 7 --every 1200
 *   pnpm sim --json                            # machine-readable summary only
 *   pnpm sim --scenario meadow --connect --ticks 288000 --every 28800   # ten town days, one road built
 */
import { parseArgs } from 'node:util';
import { buildScenario, isScenarioName, SCENARIOS, type Scenario } from '../src/sim/scenarios';
import { meadowScenario, meadowTips, planMeadowRoad } from '../src/sim/scenarios/meadow';
import type { TownView } from '../src/sim/town/town';
import { DT, World, type SimStats } from '../src/sim/world';

const { values } = parseArgs({
  args: process.argv.slice(2).filter((a) => a !== '--'),
  options: {
    scenario: { type: 'string', default: 'roundabout' },
    ticks: { type: 'string', default: String(10 * 60 * 20) },
    seed: { type: 'string', default: '1' },
    every: { type: 'string', default: '0' },
    json: { type: 'boolean', default: false },
    paint: { type: 'boolean', default: false },
    connect: { type: 'boolean', default: false },
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

const town = (view: TownView): string => {
  const { totals: t } = view;
  const clock = `${String(Math.floor(view.minuteOfDay / 60)).padStart(2, '0')}:${String(view.minuteOfDay % 60).padStart(2, '0')}`;
  return [
    `  town day ${view.day} ${clock}`,
    `homes=${view.households.length}`,
    `people=${t.population}`,
    `employed=${t.employed}/${t.adults}`,
    `cross=${t.crossCommuters}`,
    `cars=${t.cars}`,
    `upgrades=${t.houseUpgrades + t.carUpgrades}`,
    `funds=${t.meanFunds.toFixed(0)}`,
    ...[...new Set(view.households.map((h) => h.region))].map((region) => {
      const side = view.households.filter((h) => h.region === region);
      const mean = (f: (h: (typeof side)[number]) => number) => (side.reduce((sum, h) => sum + f(h), 0) / side.length).toFixed(0);
      return `${region}: funds=${mean((h) => h.funds)} wages=${mean((h) => h.wages)}`;
    }),
  ].join('  ');
};

/** Meadow Vale with one road joining the two neighbourhoods. */
function connectedMeadow(): Scenario {
  const [west, east] = meadowTips([]);
  const road = planMeadowRoad([], west!, east!);
  if (!road.ok) throw new Error(road.reason);
  return meadowScenario([road.road]);
}

if (values.connect && scenarioName !== 'meadow') {
  console.error('--connect only applies to --scenario meadow');
  process.exit(1);
}
const world = new World(values.connect ? connectedMeadow() : buildScenario(scenarioName), seed);
if (values.paint) {
  const cells = world.scenario.zones;
  if (!cells) throw new Error('--paint requires --scenario meadow');
  world.setZoning(new Map(Array.from(cells.keys, key => [key as import('../src/sim/zoning/cells').CellKey, 'residential'])));
}
const started = performance.now();
for (let t = 0; t < ticks; t++) {
  world.step();
  if (values.json || every <= 0 || world.tick % every !== 0) continue;
  console.log(fmt(world.stats()));
  const view = world.townView();
  if (view) console.log(town(view));
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
  const view = world.townView();
  if (view) console.log(town(view));
  console.log(`hash=${summary.hash}  ${summary.msPerTick}ms/tick  (${(elapsedMs / 1000).toFixed(2)}s wall)`);
}
