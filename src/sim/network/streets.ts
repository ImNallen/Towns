import { cubicPoints } from '../math/curves';
import { endOf, polyline, sampleAt, startOf, type Polyline } from '../math/polyline';
import { add, distance, dot, scale, sub, type Vec2 } from '../math/vec';
import type { Demand } from '../scenarios/types';
import { Routing } from '../traffic/routing';
import { NetworkBuilder } from './builder';
import type { Network } from './types';

const TRIM = 10;
const SPEED = 11.1;
const key = (p: Vec2): string => `${p.x},${p.y}`;

interface Arm {
  incoming: number;
  outgoing: number;
  /** Heading away from the junction. */
  tangent: Vec2;
}

function trimmed(path: Polyline, from: number, to: number): Polyline {
  const points: Vec2[] = [sampleAt(path, from, { x: 0, y: 0, hx: 0, hy: 0 })];
  for (let i = 1; i < path.cum.length - 1; i++) {
    if (path.cum[i]! > from && path.cum[i]! < to) points.push({ x: path.pts[i * 2]!, y: path.pts[i * 2 + 1]! });
  }
  points.push(sampleAt(path, to, { x: 0, y: 0, hx: 0, hy: 0 }));
  return polyline(points);
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
    const from = degrees.get(key(first))! >= 3 ? TRIM : 0;
    const to = path.length - (degrees.get(key(last))! >= 3 ? TRIM : 0);
    if (to - from < 1) throw new Error('Street is too short for junction mouths');
    const center = trimmed(path, from, to);
    const lanes = builder.addTwoWayRoad(center, { width: 8, laneWidth: 3.5, speedLimit: SPEED });
    const a = startOf(center);
    const b = endOf(center);
    const arms: [Vec2, Arm][] = [
      [first, { incoming: lanes.backward, outgoing: lanes.forward, tangent: { x: a.hx, y: a.hy } }],
      [last, { incoming: lanes.forward, outgoing: lanes.backward, tangent: { x: -b.hx, y: -b.hy } }],
    ];
    for (const [point, arm] of arms) {
      const list = nodes.get(key(point)) ?? [];
      list.push(arm);
      nodes.set(key(point), list);
    }
  }
  for (const arms of nodes.values()) {
    if (arms.length < 2) continue;
    if (arms.length === 2) {
      builder.connect(arms[0]!.incoming, arms[1]!.outgoing);
      builder.connect(arms[1]!.incoming, arms[0]!.outgoing);
      continue;
    }
    // The most opposing pair forms the priority road, independent of input order/direction.
    let main = [arms[0]!, arms[1]!];
    let opposition = Infinity;
    for (let i = 0; i < arms.length; i++) for (let j = i + 1; j < arms.length; j++) {
      const d = dot(arms[i]!.tangent, arms[j]!.tangent);
      if (d < opposition) { opposition = d; main = [arms[i]!, arms[j]!]; }
    }
    const movements = arms.flatMap((from) => arms.filter((to) => to !== from).map((to) => ({
      from, to, id: turn(builder, from.incoming, to.outgoing),
    })));
    for (const movement of movements) {
      const priority = movements.filter((other) => {
        if (other.from === movement.from || !main.includes(other.from)) return false;
        if (main.includes(movement.from)) {
          // A main-road turn across oncoming traffic yields to the opposing through movement.
          if (main.includes(movement.to) || !main.includes(other.to)) return false;
        }
        return conflicts(builder.lane(movement.id).path, builder.lane(other.id).path);
      });
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
