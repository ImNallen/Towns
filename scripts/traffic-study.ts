import { millStreet } from '../src/sim/scenarios/millStreet';
import { World } from '../src/sim/world';

// Same topology, seed and demand for both policies. Report each 24-hour interval.
for (const aware of [false, true]) {
  const world = new World(millStreet(), 7);
  world.congestionAware = aware;
  let totalSeconds = 0, completed = 0, worst = 0;
  for (let tick = 1; tick <= 288000; tick++) {
    world.step();
    if (tick % 20 === 1 && world.traffic.worst >= 0) {
      const lane = world.traffic.worst;
      worst = Math.max(worst, world.traffic.seconds[lane]! - world.traffic.free[lane]!);
    }
    if (tick % 28800) continue;
    const stats = world.stats();
    const seconds = stats.meanTripTime * stats.completed;
    console.log([aware ? 'Measured' : 'Free-flow', tick / 28800, stats.completed - completed,
      ((seconds - totalSeconds) / (stats.completed - completed)).toFixed(1), worst.toFixed(1), stats.lost].join(' | '));
    totalSeconds = seconds; completed = stats.completed; worst = 0;
  }
}
