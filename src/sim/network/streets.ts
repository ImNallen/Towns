import { cubicPoints } from '../math/curves';
import { offsetPolyline, endOf, polyline, reversePolyline, slicePolyline, startOf, type Polyline } from '../math/polyline';
import { add, cross, distance, dot, normalize, scale, sub, type Vec2 } from '../math/vec';
import type { Demand } from '../scenarios/types';
import { Routing } from '../traffic/routing';
import { NetworkBuilder } from './builder';
import { throughArms, type StreetCrossing } from './junctions';
import type { Network } from './types';

import { ROAD_TYPES, type RoadType } from './roadTypes';

export const JUNCTION_MOUTH = 10;
const key = (p: Vec2): string => `${p.x},${p.y}`;

interface Arm {
  incoming: number;
  outerIn?: number;
  outerOut?: number;
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
  const id = builder.addLane('connector', path, Math.min(builder.lane(from).speedLimit, builder.lane(to).speedLimit, straight ? Infinity : 6));
  builder.connect(from, id);
  builder.connect(id, to);
  builder.addSurface('junction', path, 4.5);
  return id;
}

/** Portals have one regional source and sink. Fork each incoming trip onto its
 * routed lane and merge departing lanes before the regional boundary. */
function avenueDirection(builder: NetworkBuilder, center: Polyline, speed: number,
  width: number, startsAtPortal: boolean, endsAtPortal: boolean, reservations: number[], pairs: [number, number][]) {
  const lead = Math.min(6, center.length / 8);
  const start = startsAtPortal ? lead * 3 : 0;
  const end = center.length - (endsAtPortal ? lead * 3 : 0);
  const lane = (from: number, to: number, offset: number) =>
    builder.addLane('road', offsetPolyline(slicePolyline(center, from, to), offset), speed);
  const entry = startsAtPortal ? lane(0, lead, -width / 2) : undefined;
  const inner = lane(start, end, -width / 2);
  const outer = lane(start, end, -1.5 * width);
  pairs.push([inner, outer]);
  const exit = endsAtPortal ? lane(center.length - lead, center.length, -width / 2) : undefined;
  if (entry !== undefined) reservations.push(turn(builder, entry, inner), turn(builder, entry, outer));
  if (exit !== undefined) {
    const through = turn(builder, inner, exit), merge = turn(builder, outer, exit);
    builder.giveWayAtEntry(merge, [through]);
    reservations.push(through, merge);
  }
  return { entry: entry ?? inner, exit: exit ?? inner,
    outerEntry: startsAtPortal ? undefined : outer, outerExit: endsAtPortal ? undefined : outer };
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
  crossings: readonly StreetCrossing[] = [], types: readonly RoadType[] = [], lights: readonly (Vec2 & { actuated?: boolean })[] = [],
): { network: Network; demand: Demand[]; entries: number[] } {
  const headings = new Map<string, Vec2[]>();
  const widths = new Map<string, Set<number>>();
  for (const [index, points] of streets.entries()) {
    if (points.length < 2) throw new Error('A street needs at least two points');
    const last = points.length - 1;
    for (const [end, neighbor] of [[points[0]!, points[1]!], [points[last]!, points[last - 1]!]] as const) {
      const node = key(end);
      const counts = widths.get(node) ?? new Set();
      counts.add(ROAD_TYPES[types[index] ?? 'town'].lanesPerDirection);
      widths.set(node, counts);
      const list = headings.get(node) ?? [];
      list.push(normalize(sub(neighbor, end)));
      headings.set(node, list);
    }
  }
  const mouthNodes = new Set<string>();
  for (const [node, arms] of headings) {
    if (widths.get(node)!.size > 1 || arms.length >= 3 || (arms.length === 2 && dot(arms[0]!, arms[1]!) > -0.999999)) mouthNodes.add(node);
  }
  const reservedMovements: number[] = [];
  const avenuePairs: [number, number][] = [];
  const portalKeys = new Set(portals.map(key));
  const corners = new Map<string, { heading: number; left?: Vec2; right?: Vec2 }[]>();
  const pedestrianLinks: NonNullable<Network['pedestrianLinks']> = [];
  const nodes = new Map<string, Arm[]>();
  for (const [index, points] of streets.entries()) {
    const path = polyline(points);
    if (!(path.length > 0)) throw new Error('A street needs positive length');
    const first = points[0]!;
    const last = points[points.length - 1]!;
    const startMouth = mouthNodes.has(key(first)) ? JUNCTION_MOUTH : 0;
    const endMouth = mouthNodes.has(key(last)) ? JUNCTION_MOUTH : 0;
    // Demolition can expose a short historical seam beside a junction. Keep part of
    // every retained street, and let its connectors reach the shortened mouths.
    const reserve = Math.min(1, path.length / 2);
    const mouthScale = Math.min(1, (path.length - reserve) / (startMouth + endMouth || 1));
    const from = startMouth * mouthScale;
    const to = path.length - endMouth * mouthScale;
    const center = slicePolyline(path, from, to);
    const type = types[index] ?? 'town';
    const spec = ROAD_TYPES[type];
    const half = spec.laneWidth * spec.lanesPerDirection;
    let forward, backward;
    if (spec.lanesPerDirection === 2) {
      const firstPortal = portalKeys.has(key(first)), lastPortal = portalKeys.has(key(last));
      forward = avenueDirection(builder, center, spec.speedLimit, spec.laneWidth, firstPortal, lastPortal, reservedMovements, avenuePairs);
      backward = avenueDirection(builder, reversePolyline(center), spec.speedLimit, spec.laneWidth, lastPortal, firstPortal, reservedMovements, avenuePairs);
      builder.addSurface('twoWay', center, half * 2, type);
    } else {
      const lanes = builder.addTwoWayRoad(center, {width: half * 2, laneWidth: spec.laneWidth, speedLimit: spec.speedLimit, roadType: type});
      forward = {entry: lanes.forward, exit: lanes.forward, outerEntry: undefined, outerExit: undefined};
      backward = {entry: lanes.backward, exit: lanes.backward, outerEntry: undefined, outerExit: undefined};
    }
    const ends = [first, last].map((point, i) => {
      const inward = i ? points[points.length - 2]! : points[1]!;
      const arm: { heading: number; left?: Vec2; right?: Vec2 } = { heading: Math.atan2(inward.y - point.y, inward.x - point.x) };
      const list = corners.get(key(point)) ?? [];
      list.push(arm);
      corners.set(key(point), list);
      return arm;
    });
    for (const side of ['left', 'right'] as const) {
      let edge = half;
      for (const strip of spec.strips) {
        if (strip.side !== 'both' && strip.side !== side) continue;
        const offset = (edge + strip.width / 2) * (side === 'left' ? 1 : -1);
        const path = offsetPolyline(center, offset);
        builder.addSurface(strip.kind, path, strip.width);
        if (strip.kind === 'pavement') {
          ends[0]![side] = startOf(path);
          ends[1]![side === 'left' ? 'right' : 'left'] = endOf(path);
        }
        edge += strip.width;
      }
    }
    const arms: [Vec2, Arm][] = [
      [first, { outerIn: backward.outerExit, outerOut: forward.outerEntry, incoming: backward.exit, outgoing: forward.entry, tangent: normalize(sub(points[1]!, first)) }],
      [last, { outerIn: forward.outerExit, outerOut: backward.outerEntry, incoming: forward.exit, outgoing: backward.entry, tangent: normalize(sub(points[points.length - 2]!, last)) }],
    ];
    for (const [point, arm] of arms) {
      const list = nodes.get(key(point)) ?? [];
      list.push(arm);
      nodes.set(key(point), list);
    }
  }

  const junctions: NonNullable<Network['junctions']> = [];
  const priorityAxes = new Map(crossings.map((c) => [key(c.point), c.priorityAxis]));
  for (const [node, arms] of nodes) {
    if (arms.length < 2) continue;
    if (arms.length === 2 && !mouthNodes.has(node)) {
      for (const [from, to] of [[arms[0]!, arms[1]!], [arms[1]!, arms[0]!]] as const) {
        builder.connect(from.incoming, to.outgoing);
        if (from.outerIn !== undefined && to.outerOut !== undefined) builder.connect(from.outerIn, to.outerOut);
      }
      continue;
    }
    const main = throughArms(arms, priorityAxes.get(node));
    const [x, y] = node.split(',').map(Number);
    const point = { x: x!, y: y! };
    const light = lights.find(p => key(p) === node);
    if (arms.length > 2) junctions.push({ point, lights: !!light, actuated: !!light?.actuated,
      arms: arms.flatMap(a => (a.outerIn === undefined ? [a.incoming] : [a.incoming, a.outerIn])
        .map(incoming => ({ incoming, group: main.includes(a) ? 0 : 1 }))) });
    const movements: { incoming: number; rank: number; id: number }[] = [];
    for (const from of arms) for (const to of arms) {
      if (from === to) continue;
      const primary = main.includes(from);
      const through = main.includes(to) === primary;
      const leftTurn = !through && cross(to.tangent, from.tangent) > 0;
      const straight = dot(from.tangent, to.tangent) < -0.75 || arms.length === 2;
      const rank = (primary ? 0 : 2) + Number(leftTurn);
      const inputs = from.outerIn === undefined ? [from.incoming] : [from.incoming, from.outerIn];
      const outputs = to.outerOut === undefined ? [to.outgoing] : [to.outgoing, to.outerOut];
      for (const [i, incoming] of inputs.entries()) {
        if (inputs.length > 1 && !straight && (i === 0) !== (cross(to.tangent, from.tangent) > 0)) continue;
        for (const [j, outgoing] of outputs.entries()) {
          if (straight && inputs.length === 2 && outputs.length === 2 && i !== j) continue;
          movements.push({ incoming, rank, id: turn(builder, incoming, outgoing) });
        }
      }
    }
    if (arms.some(arm => arm.outerIn !== undefined)) {
      for (const movement of movements) reservedMovements.push(movement.id);
    }
    for (const movement of movements) {
      const priority = movements.filter((other) =>
        other.incoming !== movement.incoming
        && (other.rank < movement.rank || (other.rank === movement.rank && other.incoming < movement.incoming))
        && conflicts(builder.lane(movement.id).path, builder.lane(other.id).path));
      builder.giveWayAtEntry(movement.id, priority.map((p) => p.id));
    }
  }
  for (const [node, arms] of corners) {
    const junction = junctions.find(j => key(j.point) === node && j.lights);
    const walkGroups = arms.map((arm, i) => [arm, 1 - (junction?.arms.find(a => a.incoming === nodes.get(node)![i]!.incoming)?.group ?? 0)] as const);
    const groups = new Map(walkGroups);
    arms.sort((a, b) => a.heading - b.heading);
    for (let i = 0; i < arms.length; i++) {
      const { left, right } = arms[i]!;
      const neighbour = arms[(i + 1) % arms.length]!.right;
      if (arms.length > 1 && left && neighbour) pedestrianLinks.push({ a: left, b: neighbour, crossing: false });
      if (arms.length !== 2 && left && right) pedestrianLinks.push({ a: left, b: right, crossing: true, signal: junction?.actuated ? junctions.indexOf(junction) : undefined, walkGroup: junction ? groups.get(arms[i]!) : undefined });
    }
  }
  const built = builder.build();
  const portalArms = portals.flatMap((p) => nodes.get(key(p)) ?? []);
  const network: Network = { ...built, avenuePairs, reservedMovements, junctions, pedestrianLinks, sinks: portalArms.map((arm) => arm.incoming) };
  const routing = new Routing(network);
  const entries = portalArms.map((arm) => arm.outgoing);
  const demand = entries.flatMap((lane, source) =>
    network.sinks.some((_, sink) => sink !== source && routing.canReach(sink, lane)) ? [{ lane, rate: 0.16 }] : []);
  return { network, demand, entries };
}
