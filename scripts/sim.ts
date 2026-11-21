/**
 * Headless simulation runner.
 *
 *   pnpm sim                                   # roundabout, seed 1, 10 sim-minutes
 *   pnpm sim --scenario straight --ticks 2400 --seed 7 --every 1200
 *   pnpm sim --json                            # machine-readable summary only
 *   pnpm sim --scenario meadow --connect --ticks 288000 --every 28800   # ten town days, one road built
 */
import { decodeCellKey, type CellKey } from '../src/sim/zoning/cells';
import { planZoneStroke, type LandUse } from '../src/sim/zoning/paint';
import { parseArgs } from 'node:util';
import { buildScenario, isScenarioName, SCENARIOS } from '../src/sim/scenarios';
import { meadowScenario, meadowTips, planMeadowRoad } from '../src/sim/scenarios/meadow';
import { BUDGET } from '../src/sim/town/economy';
import { editCost } from '../src/sim/town/budget';
import { CLOCK_START, MINUTES_PER_DAY, type TownView } from '../src/sim/town/town';
import { DT, World, type SimStats } from '../src/sim/world';

// Bare --paint retains the original residential run. An optional preset can follow it.
const args = process.argv.slice(2).filter(a => a !== '--');
const { values } = parseArgs({
  args: args.map((a, i) => a === '--paint' && (!args[i + 1] || args[i + 1]!.startsWith('--')) ? '--paint=homes' : a),
  options: {
    scenario: { type: 'string', default: 'roundabout' },
    ticks: { type: 'string', default: String(10 * 60 * 20) },
    seed: { type: 'string', default: '1' },
    every: { type: 'string', default: '0' },
    json: { type: 'boolean', default: false },
    paint: { type: 'string' },
    'parking-lot': { type: 'string' },
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
    `deliveries=${st.deliveries}`,
    `lost=${st.lost}`,
  ].join('  ');

const happiness = (view: TownView) => view.households.reduce((n, h) => n + h.happiness, 0) / Math.max(1, view.households.length);

const town = (view: TownView): string => {
  const { totals: t } = view;
  const clock = `${String(Math.floor(view.minuteOfDay / 60)).padStart(2, '0')}:${String(view.minuteOfDay % 60).padStart(2, '0')}`;
  return [
    `  town day ${view.day} ${clock}`,
    `trips=${view.parking.trips}`,
    `parked=${view.parking.parked}`,
    `turned-away=${view.parking.turnedAway}`,
    `mean-walk=${(view.parking.walkMetres / Math.max(1, view.parking.parked)).toFixed(1)}m`,
    `shop-visits=${customers}`,
    `happiness=${(100 * happiness(view)).toFixed(1)}%`,
    `homes=${view.households.length}`,
    `balance=${view.budget.balance}`,
    `taxes=${view.budget.yesterday.homes}/${view.budget.yesterday.shops}/${view.budget.yesterday.workplaces}`,
    `upkeep=${view.budget.yesterday.upkeep}`,
    `people=${t.population}`,
    `employed=${t.employed}/${t.adults}`,
    `local=${t.localWorkers}`,
    `demand=${view.demand.residential}/${view.demand.shops}/${view.demand.workplaces}`,
    `shops=${view.businesses.filter(b => b.zone === 'shops').length}`,
    `workplaces=${view.businesses.filter(b => b.zone === 'workplaces').length}`,
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
function connectingRoad() {
  const [west, east] = meadowTips([]);
  const road = planMeadowRoad([], west!, east!);
  if (!road.ok) throw new Error(road.reason);
  return road.road;
}

if (values.connect && scenarioName !== 'meadow') {
  console.error('--connect only applies to --scenario meadow');
  process.exit(1);
}
const road = values.connect ? connectingRoad() : undefined;
const world = new World(road ? meadowScenario([road]) : buildScenario(scenarioName), seed);
function pay(cost: number): void {
  const reason = world.treasury!.book(cost);
  if (reason) throw new Error(reason);
}
if (road) pay(editCost([], road));
if (values.paint !== undefined) {
  if (values.paint !== 'homes' && values.paint !== 'mixed') throw new Error('--paint expects homes or mixed');
  const cells = world.scenario.zones;
  if (!cells) throw new Error('--paint requires --scenario meadow');
  const zoning = new Map<CellKey, LandUse>();
  for (const raw of cells.keys) {
    const key = raw as CellKey;
    const { column, side } = decodeCellKey(key);
    const band = (column + side * 2) % 6;
    zoning.set(key, values.paint === 'homes' || band < 3 ? 'residential' : band === 3 ? 'shops' : 'workplaces');
  }
  if (values['parking-lot']) {
    // Reserve these consecutive frontage cells before applying the mixed paint preset.
    const start = Number(values['parking-lot']);
    const keys = [start, start + 8, start + 16] as CellKey[];
    const plan = planZoneStroke(cells, new Map(), 'parking', keys);
    if (!plan.ok) throw new Error(plan.reason);
    pay(editCost([], plan.stroke));
    for (const key of keys) zoning.set(key, 'parking');
  }
  pay([...zoning.values()].filter(use => use !== 'parking').length * BUDGET.zonePerCell);
  world.setZoning(zoning);
}
let customers = 0;
const started = performance.now();
for (let t = 0; t < ticks; t++) {
  world.step();
  if (world.tick % (MINUTES_PER_DAY / DT) === (MINUTES_PER_DAY - CLOCK_START) / DT) customers += world.townView()?.businesses.reduce((n, b) => n + b.customers, 0) ?? 0;
  if (values.json || every <= 0 || world.tick % every !== 0) continue;
  console.log(fmt(world.stats()));
  const view = world.townView();
  if (view) console.log(town(view));
}
const elapsedMs = performance.now() - started;

const finalTown = world.townView();
const summary = {
  scenario: scenarioName,
  seed,
  ticks,
  simSeconds: ticks * DT,
  hash: world.hash(),
  msPerTick: Number((elapsedMs / ticks).toFixed(4)),
  stats: world.stats(),
  parking: finalTown?.parking,
  customers,
  happiness: finalTown ? happiness(finalTown) : undefined,
};

if (values.json) {
  console.log(JSON.stringify(summary, null, 2));
} else {
  console.log(`\n${scenarioName} seed=${seed}: ${fmt(summary.stats)}`);
  const view = world.townView();
  if (view) console.log(town(view));
  console.log(`hash=${summary.hash}  ${summary.msPerTick}ms/tick  (${(elapsedMs / 1000).toFixed(2)}s wall)`);
}
