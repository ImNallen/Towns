import { cubicPoints } from '../math/curves';
import { endOf, polyline, slicePolyline, startOf, type Polyline } from '../math/polyline';
import { add, cross, distance, dot, normalize, scale, sub, type Vec2 } from '../math/vec';
import type { Demand } from '../scenarios/types';
import { Routing } from '../traffic/routing';
import { NetworkBuilder } from './builder';
import { throughArms, type StreetCrossing } from './junctions';
import type { Network } from './types';

export const JUNCTION_MOUTH = 10;
const SPEED = 11.1;
const key = (p: Vec2): string => `${p.x},${p.y}`;

interface Arm {
  incoming: number;
  outgoing: number;
  /** Heading away from the junction. */
  tangent: Vec2;
}

function turn(builder: NetworkBuilder, from: number, to: number): number {
  const a = endOf(builder.lane(from).path);
  const b = startOf(builder.lane(to).path);
  const ah = { x: a.hx, y: a.hy };
  const bh = { x: b.hx, y: b.hy };
  const handle = distance(a, b) * 0.55;
  // Explicit tangent leads make the sampled curve join both roads without a heading jump.
  const path = polyline([a, ...cubicPoints(
    add(a, scale(ah, 0.1)), add(a, scale(ah, handle)),
    sub(b, scale(bh, handle)), sub(b, scale(bh, 0.1)), 0.4,
  ), b]);
  const straight = dot(ah, bh) > 0.95;
  const id = builder.addLane('connector', path, straight ? SPEED : 6);
  builder.connect(from, id);
  builder.connect(id, to);
  builder.addSurface('junction', path, 4.5);
  return id;
}

/** True for crossing paths and merges (nearby sampled centre lines within a vehicle width). */
function conflicts(a: Polyline, b: Polyline): boolean {
  for (let i = 0; i < a.pts.length; i += 2) {
    for (let j = 0; j < b.pts.length; j += 2) {
      if (Math.hypot(a.pts[i]! - b.pts[j]!, a.pts[i + 1]! - b.pts[j + 1]!) < 2.8) return true;
    }
  }
  return false;
}

/** Build streets whose shared endpoints are nodes. Smooth degree-two nodes should be coalesced. */
export function buildStreetNetwork(
  builder: NetworkBuilder, streets: readonly (readonly Vec2[])[], portals: readonly Vec2[],
  crossings: readonly StreetCrossing[] = [],
): { network: Network; demand: Demand[] } {
  const degrees = new Map<string, number>();
  for (const points of streets) {
    if (points.length < 2) throw new Error('A street needs at least two points');
    for (const p of [points[0]!, points[points.length - 1]!]) degrees.set(key(p), (degrees.get(key(p)) ?? 0) + 1);
  }
  const nodes = new Map<string, Arm[]>();
  for (const points of streets) {
    const path = polyline(points);
    const first = points[0]!;
    const last = points[points.length - 1]!;
    const from = degrees.get(key(first))! >= 3 ? JUNCTION_MOUTH : 0;
    const to = path.length - (degrees.get(key(last))! >= 3 ? JUNCTION_MOUTH : 0);
    if (to - from < 1) throw new Error('Street is too short for junction mouths');
    const center = slicePolyline(path, from, to);
    const lanes = builder.addTwoWayRoad(center, { width: 8, laneWidth: 3.5, speedLimit: SPEED });
    const arms: [Vec2, Arm][] = [
      [first, { incoming: lanes.backward, outgoing: lanes.forward, tangent: normalize(sub(points[1]!, first)) }],
      [last, { incoming: lanes.forward, outgoing: lanes.backward, tangent: normalize(sub(points[points.length - 2]!, last)) }],
    ];
    for (const [point, arm] of arms) {
      const list = nodes.get(key(point)) ?? [];
      list.push(arm);
      nodes.set(key(point), list);
    }
  }
  const priorityAxes = new Map(crossings.map((c) => [key(c.point), c.priorityAxis]));
  for (const [node, arms] of nodes) {
    if (arms.length < 2) continue;
    if (arms.length === 2) {
      builder.connect(arms[0]!.incoming, arms[1]!.outgoing);
      builder.connect(arms[1]!.incoming, arms[0]!.outgoing);
      continue;
    }
    const main = throughArms(arms, priorityAxes.get(node));
    const movements = arms.flatMap((from) => arms.filter((to) => to !== from).map((to) => {
      const primary = main.includes(from);
      const through = main.includes(to) === primary;
      const leftTurn = !through && cross(to.tangent, from.tangent) > 0;
      const rank = (primary ? 0 : 2) + Number(leftTurn);
      return { from, rank, id: turn(builder, from.incoming, to.outgoing) };
    }));
    for (const movement of movements) {
      const priority = movements.filter((other) =>
        other.from !== movement.from
        && (other.rank < movement.rank || (other.rank === movement.rank && other.from.incoming < movement.from.incoming))
        && conflicts(builder.lane(movement.id).path, builder.lane(other.id).path));
      builder.giveWayAtEntry(movement.id, priority.map((p) => p.id));
    }
  }
  const built = builder.build();
  const portalArms = portals.flatMap((p) => nodes.get(key(p)) ?? []);
  const network: Network = { ...built, sinks: portalArms.map((arm) => arm.incoming) };
  const routing = new Routing(network);
  const connected = portals.length === 2 && portalArms.length === 2
    && portalArms.every((arm, i) => routing.canReach(1 - i, arm.outgoing));
  return { network, demand: connected ? portalArms.map((arm) => ({ lane: arm.outgoing, rate: 0.16 })) : [] };
}
