import { expect, it } from 'vitest';
import { World } from '../../src/sim/world';
import { millStreet } from '../../src/sim/scenarios/millStreet';
import { Routing } from '../../src/sim/traffic/routing';

it('keeps the established turn through small cost reversals, then diverts around sustained delay', () => {
  const { network } = millStreet();
  const routing = new Routing(network);
  const times = Float64Array.from(network.lanes, l => l.length / l.speedLimit);
  expect(routing.nextHop(0, 0)).toBe(1);
  times[1] += 20;
  routing.refresh(0, times);
  expect(routing.nextHop(0, 0)).toBe(4);
  for (let i = 1; i <= 8; i++) {
    times[1] = times[4]! - times[3]! + (i % 2 ? 1 : -1);
    routing.refresh(200 * i, times);
    expect(routing.nextHop(0, 0)).toBe(4);
  }
});

it('diverts live vehicles onto the bypass under load and repeats without losing trips', () => {
  function run(aware: boolean) {
    const w = new World(millStreet(), 7);
    w.congestionAware = aware;
    let bypass = false, jam = false;
    for (let i = 0; i < 12000; i++) {
      w.step();
      if (i % 20) continue;
      bypass ||= w.traffic.volume[4]! > 0;
      jam ||= w.traffic.view().jam >= 0;
    }
    return { hash: w.hash(), bypass, jam, lost: w.stats().lost };
  }
  expect(run(false)).toMatchObject({ bypass: false, jam: true, lost: 0 });
  const first = run(true);
  expect(first).toMatchObject({ bypass: true, jam: true, lost: 0 });
  expect(run(true)).toEqual(first);
});
