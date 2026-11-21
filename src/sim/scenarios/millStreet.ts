import { polyline } from '../math/polyline';
import { NetworkBuilder } from '../network/builder';
import type { Scenario } from './types';

/** A traffic study: Mill Street gives way at the works entrance; the longer north road avoids it. */
export function millStreet(): Scenario {
  const b = new NetworkBuilder();
  function street(points: number[][]) {
    const path = polyline(points.map(([x, y]) => ({ x: x!, y: y! })));
    b.addSurface('oneWay', path, 4.5);
    return b.addLane('road', path, 12);
  }
  const entry = street([[-250, 0], [-100, 0]]);
  const mill = street([[-100, 0], [30, 0]]);
  const works = street([[30, -180], [30, 0]]);
  const main = street([[30, 0], [120, 0]]);
  const north = street([[-100, 0], [-75, 25], [-58, 34], [80, 34], [94, 26], [120, 0]]);
  const exit = street([[120, 0], [320, 0]]);
  b.connect(entry, mill);
  b.connect(entry, north);
  b.connect(mill, main);
  b.connect(works, main);
  b.giveWay(mill, [works]);
  b.connect(main, exit);
  b.connect(north, exit);
  b.giveWay(north, [main]);
  return { name: 'mill', network: b.build(), demand: [{ lane: entry, rate: 0.22, offPeakRate: 0.06 }, { lane: works, rate: 0.22, offPeakRate: 0.06 }],
    bounds: { minX: -250, maxX: 320, minY: -180, maxY: 80 }, decor: { hills: [], lakes: [], houses: [] } };
}
