import { polyline } from '../math/polyline';
import { vec2 } from '../math/vec';
import { NetworkBuilder } from '../network/builder';
import type { Scenario } from './types';

/** One straight two-way road. Minimal scenario for car-following tests. */
export function straightRoad(): Scenario {
  const b = new NetworkBuilder();
  const centerline = polyline([vec2(-400, 0), vec2(0, 0), vec2(400, 0)]);
  const road = b.addTwoWayRoad(centerline, { width: 8, laneWidth: 3.5, speedLimit: 13.9 });
  return {
    name: 'straight',
    network: b.build(),
    demand: [
      { lane: road.forward, rate: 0.35 },
      { lane: road.backward, rate: 0.35 },
    ],
    decor: { houses: [], lakes: [], hills: [] },
    bounds: { minX: -400, minY: -150, maxX: 400, maxY: 150 },
  };
}
