// Run with pnpm exec tsx scripts/walker-benchmark.ts.
import { Walkers, WalkingNetwork } from '../src/sim/network/walking';
import { NetworkBuilder } from '../src/sim/network/builder';
import { buildStreetNetwork } from '../src/sim/network/streets';
import { DT } from '../src/sim/world';

const { network } = buildStreetNetwork(
  new NetworkBuilder(),
  [
    [
      { x: 0, y: 0 },
      { x: 200, y: 0 },
    ],
  ],
  [],
);
const doors = Array.from({ length: 101 }, (_, i) => ({ x: i * 2, y: 6 }));
const graph = new WalkingNetwork(network, doors, []);
for (let run = 0; run < 6; run++) {
  const walkers = new Walkers(graph, 300);
  for (let p = 0; p < 300; p++) {
    if (!walkers.start(p, p % 50, (p % 50) + 51, 30)) throw new Error('Missing route');
  }
  const ticks = 1200;
  const start = performance.now();
  for (let t = 0; t < ticks; t++) walkers.step(DT);
  const cost = (performance.now() - start) / ticks;
  if (walkers.count !== 300 || walkers.node[0] === graph.places[0]) throw new Error('Unexpected walker progress');
  if (run) console.log(cost.toFixed(4) + ' ms per walker update (300 agents)');
}
