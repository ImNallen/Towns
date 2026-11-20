import { arcPoints, cubicPoints } from '../math/curves';
import { polyline, sampleAt, type PathSample, type Polyline } from '../math/polyline';
import { add, distance, fromAngle, normalize, perp, scale, sub, vec2, type Vec2 } from '../math/vec';
import { NetworkBuilder } from '../network/builder';
import type { Demand, House, Scenario } from './types';

const TAU = Math.PI * 2;
const CENTER = vec2(0, 0);

/** Ring lane radius (m). */
const RING_RADIUS = 30;
const RING_WIDTH = 9;
/** Distance from the centre at which approach roads end and connectors begin. */
const APPROACH_END = 58;
/** Angular offset of exit (−) and entry (+) points from each approach axis. */
const PORT_OFFSET = 0.32;

const LANE_WIDTH = 3.5;
const ROAD_WIDTH = 8;
const CONNECTOR_WIDTH = 4.5; // lane offset ± half this = road edge, so the flare meets the road cleanly
const DRIVEWAY_WIDTH = 3;

const ROAD_SPEED = 13.9; // 50 km/h
const RING_SPEED = 8.5;
const CONNECTOR_SPEED = 8;

interface ApproachSpec {
  /** Direction from the roundabout centre, radians. */
  angle: number;
  far: Vec2;
  farDirection: Vec2;
  /** Arrivals per second entering from the far end. */
  demand: number;
  /** Houses along the road: which side (+1 left / −1 right, looking outward). */
  houses?: { side: 1 | -1; from: number; spacing: number };
}

const APPROACHES: ApproachSpec[] = [
  { angle: Math.PI, far: vec2(-480, 30), farDirection: vec2(-1, 0), demand: 0.12, houses: { side: -1, from: 90, spacing: 23 } },
  { angle: Math.PI / 2 - 0.08, far: vec2(70, 420), farDirection: vec2(0.1, 1), demand: 0.08, houses: { side: -1, from: 95, spacing: 25 } },
  { angle: -0.12, far: vec2(480, -40), farDirection: vec2(1, 0.05), demand: 0.1 },
  { angle: -Math.PI / 2 - 0.35, far: vec2(-120, -420), farDirection: vec2(-0.1, -1), demand: 0.08 },
];

const wrapAngle = (a: number): number => ((a % TAU) + TAU) % TAU;

/** A single-lane roundabout with four approach roads and a few streets of houses. */
export function roundaboutTown(): Scenario {
  const b = new NetworkBuilder();
  const roadOpts = { width: ROAD_WIDTH, laneWidth: LANE_WIDTH, speedLimit: ROAD_SPEED };

  const approaches = APPROACHES.map((spec) => {
    const u = fromAngle(spec.angle);
    const near = add(CENTER, scale(u, APPROACH_END));
    const k = distance(near, spec.far) * 0.35;
    const fd = normalize(spec.farDirection);
    const centerline = polyline(
      cubicPoints(near, add(near, scale(u, k)), sub(spec.far, scale(fd, k)), spec.far, 2),
    );
    // Forward runs outward (exit), backward runs inward (arrival).
    const road = b.addTwoWayRoad(centerline, roadOpts);
    return { spec, centerline, road };
  });

  // Ring: split into arcs at every exit/entry port, in counter-clockwise order.
  const ports = approaches.flatMap((a, i) => [
    { angle: wrapAngle(a.spec.angle - PORT_OFFSET), kind: 'exit' as const, approach: i },
    { angle: wrapAngle(a.spec.angle + PORT_OFFSET), kind: 'entry' as const, approach: i },
  ]);
  ports.sort((p, q) => p.angle - q.angle);

  const ring = ports.map((port, k) => {
    const nextPort = ports[(k + 1) % ports.length]!;
    const a1 = nextPort.angle > port.angle ? nextPort.angle : nextPort.angle + TAU;
    return b.addLane('ring', polyline(arcPoints(CENTER, RING_RADIUS, port.angle, a1)), RING_SPEED);
  });
  ring.forEach((id, k) => b.connect(id, ring[(k + 1) % ring.length]!));

  ports.forEach((port, k) => {
    const arriving = ring[(k - 1 + ring.length) % ring.length]!; // ring arc ending at this port
    const leaving = ring[k]!; // ring arc starting at this port
    const { road } = approaches[port.approach]!;
    if (port.kind === 'exit') {
      b.addConnector(arriving, road.forward, CONNECTOR_SPEED, CONNECTOR_WIDTH);
    } else {
      const entry = b.addConnector(road.backward, leaving, CONNECTOR_SPEED, CONNECTOR_WIDTH);
      b.giveWay(entry, [arriving]);
    }
  });

  b.addSurface('oneWay', polyline(arcPoints(CENTER, RING_RADIUS, 0, TAU, 1.5, false), true), RING_WIDTH);

  const houses: House[] = [];
  for (const a of approaches) {
    if (a.spec.houses) placeHouses(b, a.centerline, a.spec.houses, houses);
  }

  const demand: Demand[] = approaches.map((a) => ({ lane: a.road.backward, rate: a.spec.demand }));

  return {
    name: 'roundabout',
    network: b.build(),
    demand,
    decor: {
      houses,
      lakes: [{ x: -250, y: 255, radius: 115, seed: 3 }],
      hills: [
        { x: -350, y: -285, radius: 175, seed: 7, levels: 5 },
        { x: 480, y: 170, radius: 120, seed: 11, levels: 4 },
      ],
    },
    bounds: { minX: -480, minY: -420, maxX: 480, maxY: 420 },
  };
}

function placeHouses(
  b: NetworkBuilder,
  road: Polyline,
  opts: { side: 1 | -1; from: number; spacing: number },
  out: House[],
): void {
  const sample: PathSample = { x: 0, y: 0, hx: 0, hy: 0 };
  let variant = out.length;
  for (let s = opts.from; s < road.length - 40; s += opts.spacing) {
    sampleAt(road, s, sample);
    const p = vec2(sample.x, sample.y);
    const n = scale(perp(vec2(sample.hx, sample.hy)), opts.side);
    const front = add(p, scale(n, 13.5));
    const center = add(p, scale(n, 19));
    b.addSurface('driveway', polyline([add(p, scale(n, ROAD_WIDTH / 2 - 0.5)), front]), DRIVEWAY_WIDTH);
    out.push({ x: center.x, y: center.y, angle: Math.atan2(sample.hy, sample.hx), variant: variant++ });
  }
}
