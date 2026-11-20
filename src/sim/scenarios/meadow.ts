import { cubicPoints } from '../math/curves';
import { polyline, type Polyline } from '../math/polyline';
import { add, distance, dot, normalize, scale, sub, type Vec2 } from '../math/vec';
import { NetworkBuilder } from '../network/builder';
import type { Bounds, Decor, Scenario } from './types';

/** A committed, sampled road segment returned by planMeadowRoad. */
export interface MeadowRoad {
  readonly points: readonly Vec2[];
}

type Plan = { ok: true; road: MeadowRoad; path: Polyline } | { ok: false; reason: string };
const WIDTH = 8;
const MIN_LENGTH = 12;
const MIN_RADIUS = 18;
const BOUNDS: Bounds = { minX: -180, maxX: 180, minY: -115, maxY: 115 };

function scenery(): Decor {
  return {
    houses: [-145, -118, -91, 91, 118, 145].flatMap((x, i) => [
      { x, y: x < 0 ? -29 : 29, angle: 0, variant: i },
      { x, y: x < 0 ? 15 : -15, angle: 0, variant: i + 2 },
    ]),
    lakes: [{ x: -105, y: 76, radius: 23, seed: 3 }],
    hills: [
      { x: 111, y: -78, radius: 25, seed: 7, levels: 4 },
      { x: 133, y: 84, radius: 19, seed: 11, levels: 3 },
    ],
  };
}

const same = (a: Vec2, b: Vec2): boolean => a.x === b.x && a.y === b.y;
const tip = (chain: readonly Vec2[]): Vec2 => chain[chain.length - 1]!;
const heading = (chain: readonly Vec2[]): Vec2 => normalize(sub(tip(chain), chain[chain.length - 2]!));

/** Chains run from the map edge toward their playable tip. A joined map has one chain. */
function chainsFor(roads: readonly MeadowRoad[]): Vec2[][] {
  let chains: Vec2[][] = [
    [{ x: -170, y: -8 }, { x: -45, y: -8 }],
    [{ x: 170, y: 8 }, { x: 45, y: 8 }],
  ];
  for (const road of roads) {
    if (chains.length !== 2 || road.points.length < 2) throw new Error('Invalid meadow road history');
    const first = road.points[0]!;
    const last = tip(road.points);
    const source = chains.findIndex((c) => same(tip(c), first));
    if (source < 0) throw new Error('Meadow road must start at an open tip');
    const target = chains.findIndex((c, i) => i !== source && same(tip(c), last));
    const extended = [...chains[source]!, ...road.points.slice(1)];
    if (target >= 0) chains = [[...extended, ...chains[target]!.slice(0, -1).reverse()]];
    else chains[source] = extended;
  }
  return chains;
}

export function meadowTips(roads: readonly MeadowRoad[]): Vec2[] {
  const chains = chainsFor(roads);
  return chains.length === 2 ? chains.map((c) => ({ ...tip(c) })) : [];
}

export function meadowScenario(roads: readonly MeadowRoad[] = []): Scenario {
  const chains = chainsFor(roads);
  const builder = new NetworkBuilder();
  const lanes = chains.map((points) => builder.addTwoWayRoad(polyline(points), {
    width: WIDTH, laneWidth: 3.5, speedLimit: 11.1,
  }));
  const connected = chains.length === 1;
  return {
    name: 'meadow',
    network: builder.build(),
    demand: connected ? [
      { lane: lanes[0]!.forward, rate: 0.16 },
      { lane: lanes[0]!.backward, rate: 0.16 },
    ] : [],
    bounds: { ...BOUNDS },
    decor: scenery(),
  };
}

function pointSegmentDistance(p: Vec2, a: Vec2, b: Vec2): number {
  const delta = sub(b, a);
  const t = Math.max(0, Math.min(1, dot(sub(p, a), delta) / dot(delta, delta)));
  return distance(p, add(a, scale(delta, t)));
}

function blockedByScenery(p: Vec2, decor: Decor): boolean {
  if ([...decor.lakes, ...decor.hills].some((blob) => distance(p, blob) < blob.radius * 1.3 + WIDTH / 2 + 2)) return true;
  return decor.houses.some((house) => {
    const d = sub(p, house);
    const x = d.x * Math.cos(house.angle) + d.y * Math.sin(house.angle);
    const y = -d.x * Math.sin(house.angle) + d.y * Math.cos(house.angle);
    return Math.abs(x) < 12 && Math.abs(y) < 12;
  });
}

export function planMeadowRoad(roads: readonly MeadowRoad[], start: Vec2, end: Vec2): Plan {
  const fail = (reason: string): Plan => ({ ok: false, reason });
  if (![start.x, start.y, end.x, end.y].every(Number.isFinite)) return fail('Choose a point inside the meadow.');
  const chains = chainsFor(roads);
  if (chains.length !== 2) return fail('The streets are already connected.');
  const source = chains.findIndex((c) => same(tip(c), start));
  if (source < 0) return fail('Start at an open street tip.');
  const target = chains.findIndex((c, i) => i !== source && same(tip(c), end));
  const span = distance(start, end);
  if (span < MIN_LENGTH) return fail('Build at least 12 metres of street.');
  const chord = normalize(sub(end, start));
  const incoming = heading(chains[source]!);
  const outgoing = target >= 0 ? scale(heading(chains[target]!), -1) : chord;
  if (dot(chord, incoming) < 0.45 || dot(chord, outgoing) < 0.45) return fail('Continue forward from the tip; avoid backtracking.');

  const handle = span / 3;
  // Short tangent leads make offset lane endpoints coincide exactly at segment joins.
  const points = [start, ...cubicPoints(
    add(start, scale(incoming, 0.25)), add(start, scale(incoming, handle)),
    sub(end, scale(outgoing, handle)), sub(end, scale(outgoing, 0.25)), 0.6,
  ), end];
  const path = polyline(points);
  for (let i = 1; i < points.length - 1; i++) {
    const a = sub(points[i]!, points[i - 1]!);
    const b = sub(points[i + 1]!, points[i]!);
    const turn = Math.acos(Math.max(-1, Math.min(1, dot(normalize(a), normalize(b)))));
    if (turn > (distance(points[i - 1]!, points[i + 1]!) / 2) / MIN_RADIUS) {
      return fail('That bend is too tight. Try a longer, gentler curve.');
    }
  }
  const decor = scenery();
  for (let i = 0; i < points.length; i++) {
    const p = points[i]!;
    const margin = WIDTH / 2 + 2;
    if (p.x < BOUNDS.minX + margin || p.x > BOUNDS.maxX - margin || p.y < BOUNDS.minY + margin || p.y > BOUNDS.maxY - margin) return fail('Keep the whole street inside the meadow.');
    if (blockedByScenery(p, decor)) return fail('Leave room around buildings, water and hills.');
    for (let c = 0; c < chains.length; c++) {
      const chain = chains[c]!;
      for (let j = 1; j < chain.length; j++) {
        // Only the local portion at an intended join may touch the existing street.
        const joint = c === source ? start : c === target ? end : undefined;
        if (joint && distance(p, joint) < 12 && distance(chain[j]!, joint) < 12) continue;
        if (pointSegmentDistance(p, chain[j - 1]!, chain[j]!) < WIDTH + 1) {
          // The starter streets are single long segments, so trim their intended join.
          if (joint && same(chain[j]!, joint)) {
            const trimmed = sub(joint, scale(heading(chain), 12));
            if (pointSegmentDistance(p, chain[j - 1]!, trimmed) >= WIDTH + 1) continue;
          }
          return fail('Streets need space; crossings are not supported here.');
        }
      }
    }
    for (let j = 1; j < i; j++) {
      if (path.cum[i]! - path.cum[j]! < 20) continue;
      if (pointSegmentDistance(p, points[j - 1]!, points[j]!) < WIDTH + 1) return fail('The street cannot cross or fold back on itself.');
    }
  }
  return { ok: true, road: { points }, path };
}
