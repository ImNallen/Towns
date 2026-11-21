import { studyTown } from './town-layout';

// Identical seed, starter households and mixed-zone pattern in all three towns.
for (const layout of ['Sensible', 'Well-planned', 'Jammed'] as const) {
  const world = studyTown(layout);
  for (let day = 1; day <= 10; day++) {
    for (let t = 0; t < 28800; t++) world.step();
    const town = world.townView()!;
    const happiness = town.households.reduce((sum, h) => sum + h.happiness, 0) / town.households.length;
    console.log([layout, day, (100 * happiness).toFixed(1), town.households.length,
      town.totals.population, town.parking.turnedAway, world.stats().meanTripTime.toFixed(1), world.stats().lost].join(' | '));
  }
}
