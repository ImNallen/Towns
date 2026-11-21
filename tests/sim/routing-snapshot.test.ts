import { expect, it } from 'vitest';
import { buildScenario } from '../../src/sim/scenarios';
import { World } from '../../src/sim/world';
import { packWorld, unpackWorld } from '../../src/worker/snapshot';

it('restores each cost and turn exactly partway through a congested routing sweep', async () => {
  const map = buildScenario('mill');
  const live = new World(map, 5);
  for (let i = 0; i < 10193; i++) live.step();
  const loaded = new World(map, 5, live.vehicles.capacity, live.tick);
  await unpackWorld(loaded, await packWorld(live));
  for (let dest = 0; dest < live.routing.destinations; dest++) {
    for (const lane of live.network.lanes) {
      expect(loaded.routing.nextHop(dest, lane.id)).toBe(live.routing.nextHop(dest, lane.id));
      expect(loaded.routing.travelTime(dest, lane.id)).toBe(live.routing.travelTime(dest, lane.id));
      expect(loaded.routing.timeFrom(dest, lane.id, 2.5)).toBe(live.routing.timeFrom(dest, lane.id, 2.5));
    }
  }
  for (let i = 0; i < 28800; i++) {
    live.step();
    loaded.step();
  }
  expect(loaded.stats()).toEqual(live.stats());
  expect(loaded.hash()).toBe(live.hash());
});
