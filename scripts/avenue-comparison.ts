/** Ten days of eastbound through demand at a fixed-time Avenue T-junction. */
import { NetworkBuilder } from '../src/sim/network/builder';
import { buildStreetNetwork } from '../src/sim/network/streets';
import { meadowScenario, meadowSegmentInfo, meadowTips, planMeadowRoad, type MeadowEdit } from '../src/sim/scenarios/meadow';
import { decodeCellKey, type CellKey } from '../src/sim/zoning/cells';
import type { LandUse } from '../src/sim/zoning/paint';
import { World } from '../src/sim/world';

const west = {x:-320, y:0}, fork = {x:-160, y:0}, junction = {x:0, y:0};
const east = {x:180, y:0}, north = {x:0, y:120};
const {network, entries} = buildStreetNetwork(new NetworkBuilder(),
  [[west,fork],[fork,junction],[junction,east],[junction,north]], [west,east], [],
  ['town','avenue','avenue','town'], [junction]);
const world = new World({...meadowScenario(), network, town:undefined, demand:[{lane:entries[0]!, rate:0.48}]},1);
const [inner, outer] = network.junctions![0]!.arms.map(arm => arm.incoming);
const approaches = [inner!,outer!];
const counts = approaches.map(() => ({through:0, stoppedTicks:0, peak:0}));
const v = world.vehicles;
const previous = new Int32Array(v.capacity);
let queuedTicks = 0, bothQueuedTicks = 0, totalImbalance = 0, upstreamStoppedTicks = 0;
const ticks = 288000;
for (let t=0; t<ticks; t++) {
  previous.set(v.lane.subarray(0,v.highWater));
  world.step();
  const queues: number[] = [];
  for (const [index,lane] of approaches.entries()) {
    const row = counts[index]!;
    let queue = 0;
    for (let i=0; i<v.highWater; i++) {
      if (!v.alive[i]) continue;
      if (v.lane[i] === lane && v.v[i]! < 1) queue++;
      if (previous[i] === lane && network.lanes[lane]!.next.includes(v.lane[i]!)) row.through++;
    }
    queues.push(queue);
    row.stoppedTicks += queue;
    row.peak = Math.max(row.peak,queue);
  }
  if (queues[0]! + queues[1]! > 0) queuedTicks++;
  if (queues[0]! > 0 && queues[1]! > 0) bothQueuedTicks++;
  totalImbalance += Math.abs(queues[0]! - queues[1]!);
  for (let i=0; i<v.highWater; i++) if(v.alive[i] && v.lane[i] === entries[0] && v.v[i]! < 1) upstreamStoppedTicks++;
}
console.log('Both lanes queued / queued ticks', bothQueuedTicks/queuedTicks, 'mean absolute queue difference', totalImbalance/ticks, 'mean feeder queue',upstreamStoppedTicks/ticks);
console.table(counts.map((row,i) => ({lane:i?'outer':'inner', entries:row.through,
  meanQueue:row.stoppedTicks/ticks, peakQueue:row.peak})));
console.log('Mean completed trip (s)',world.stats().meanTripTime,'lost',world.stats().lost,'hash',world.hash());

// Use the same signalised T and east approach as avenue-lights.png, with mixed land use.
const [westTip, eastTip] = meadowTips([]);
const edits: MeadowEdit[] = [];
for (const [start, end] of [[eastTip!, westTip!], [junction, {x:0, y:45}]] as const) {
  const plan = planMeadowRoad(edits, start, end);
  if (!plan.ok) throw new Error(plan.reason);
  edits.push(plan.road);
}
const eastApproach = meadowSegmentInfo(edits).findIndex(section =>
  section.points.some(point => point.x >= 40) && section.points.some(point => Math.abs(point.x) < 3));
if (eastApproach < 0) throw new Error('Missing east approach');
edits.push({upgrade:eastApproach, roadType:'avenue'});
edits.push({lights:meadowScenario(edits).network.junctions![0]!.point});
const mixed = new World(meadowScenario(edits), 1);
const zoning = new Map<CellKey, LandUse>();
for (const raw of mixed.scenario.zones!.keys) {
  const key = raw as CellKey;
  const {column, side} = decodeCellKey(key);
  const band = (column + side * 2) % 6;
  zoning.set(key, band < 3 ? 'residential' : band === 3 ? 'shops' : 'workplaces');
}
mixed.setZoning(zoning);
for (let t = 0; t < ticks; t++) mixed.step();
const stats = mixed.stats();
console.log('Mixed Meadow with Avenue T: mean completed trip (s)', stats.meanTripTime,
  'completed', stats.completed, 'lost', stats.lost, 'hash', mixed.hash());
