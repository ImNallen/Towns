import { cubicPoints } from '../math/curves';
import { polyline, type Polyline } from '../math/polyline';
import { add, distance, dot, normalize, projectOntoSegment, scale, sub, type Vec2 } from '../math/vec';
import type { StreetPoint } from '../network/angleSnap';
import { NetworkBuilder } from '../network/builder';
import { buildStreetNetwork } from '../network/streets';
import type { Bounds, Decor, House, Scenario } from './types';

export interface MeadowRoad {
  readonly points: readonly Vec2[];
}

type Plan = { ok: true; road: MeadowRoad; path: Polyline } | { ok: false; reason: string };
const WIDTH = 8;
const TANGENT_LEAD = 0.25;
const MIN_LENGTH = 12;
const MIN_RADIUS = 18;
const BOUNDS: Bounds = { minX: -180, maxX: 180, minY: -115, maxY: 115 };

function gardenHouse(x: number, y: number, variant: number): House {
  const roadY = x < 0 ? -8 : 8;
  const verge = roadY + Math.sign(y - roadY) * (WIDTH / 2 + 0.8);
  const back = y + Math.sign(y - roadY) * 9;
  return { x, y, angle: 0, variant, garden: {
    minX: x - 11, maxX: x + 12, minY: Math.min(verge, back), maxY: Math.max(verge, back),
  } };
}

function scenery(): Decor {
  return {
    houses: [-145, -118, -91, 91, 118, 145].flatMap((x, i) => [
      gardenHouse(x, x < 0 ? -26 - i % 3 : 25 + i % 3, i),
      gardenHouse(x + 4, x < 0 ? 12 + i % 3 : -12 - i % 3, i + 2),
    ]),
    lakes: [{ x: -105, y: 76, radius: 23, seed: 3 }],
    hills: [
      { x: 111, y: -78, radius: 25, seed: 7, levels: 4 },
      { x: 133, y: 84, radius: 19, seed: 11, levels: 3 },
    ],
  };
}

const same = (a: Vec2, b: Vec2): boolean => distance(a, b) < 1e-6;
const tip = (chain: readonly Vec2[]): Vec2 => chain[chain.length - 1]!;
const PORTALS: readonly Vec2[] = [{ x: -185, y: -8 }, { x: 185, y: 8 }];
const isPortal = (p: Vec2): boolean => PORTALS.some((portal) => same(p, portal));

/** Replay into maximal chains whose endpoints are dead ends, portals or junctions. */
export function meadowStreets(roads: readonly MeadowRoad[]): Vec2[][] {
  let chains: Vec2[][] = [
    [PORTALS[0]!, { x: -45, y: -8 }],
    [PORTALS[1]!, { x: 45, y: 8 }],
  ];
  for (const road of roads) {
    for (const endpoint of [road.points[0]!, tip(road.points)]) {
      const split: Vec2[][] = [];
      for (const original of chains) {
        const chain = original.map((p) => same(p, endpoint) ? endpoint : p);
        let cut = false;
        if (!same(endpoint, chain[0]!) && !same(endpoint, tip(chain))) {
          for (let i = 1; i < chain.length; i++) {
            if (pointSegmentDistance(endpoint, chain[i - 1]!, chain[i]!) < 1e-6) {
              const before = chain.slice(0, i);
              const after = chain.slice(i);
              if (!same(tip(before), endpoint)) before.push(endpoint);
              if (!same(after[0]!, endpoint)) after.unshift(endpoint);
              split.push(before, after);
              cut = true;
              break;
            }
          }
        }
        if (!cut) split.push(chain);
      }
      chains = split;
    }
    chains.push([...road.points]);
    for (const endpoint of [road.points[0]!, tip(road.points)]) {
      const incident = chains.flatMap((c, i) => [c[0]!, tip(c)].filter((p) => same(p, endpoint)).map(() => i));
      if (incident.length !== 2 || incident[0] === incident[1]) continue;
      const [i, j] = incident;
      const first = same(tip(chains[i]!), endpoint) ? chains[i]! : [...chains[i]!].reverse();
      const second = same(chains[j]![0]!, endpoint) ? chains[j]! : [...chains[j]!].reverse();
      chains[i] = [...first, ...second.slice(1)];
      chains.splice(j, 1);
    }
  }
  return chains;
}

function degree(chains: readonly (readonly Vec2[])[], p: Vec2): number {
  return chains.reduce((sum, c) => sum + Number(same(c[0]!, p)) + Number(same(tip(c), p)), 0);
}

export function meadowTips(roads: readonly MeadowRoad[]): Vec2[] {
  const chains = meadowStreets(roads);
  return chains.flatMap((c) => [c[0]!, tip(c)])
    .filter((p) => !isPortal(p) && degree(chains, p) === 1).map((p) => ({ ...p }));
}

export function meadowConnected(roads: readonly MeadowRoad[]): boolean {
  const chains = meadowStreets(roads);
  const reached: Vec2[] = [PORTALS[0]!];
  for (let i = 0; i < reached.length; i++) {
    for (const chain of chains) {
      if (same(chain[0]!, reached[i]!) && !reached.some((p) => same(p, tip(chain)))) reached.push(tip(chain));
      if (same(tip(chain), reached[i]!) && !reached.some((p) => same(p, chain[0]!))) reached.push(chain[0]!);
    }
  }
  return reached.some((p) => same(p, PORTALS[1]!));
}

export function meadowSnap(roads: readonly MeadowRoad[], point: Vec2, radius: number): Vec2 | undefined {
  return snapToMeadowStreet(meadowStreets(roads), point, radius)?.point;
}

export function snapToMeadowStreet(chains: readonly (readonly Vec2[])[], point: Vec2, radius: number): StreetPoint | undefined {
  if (![point.x, point.y, radius].every(Number.isFinite) || radius < 0) return undefined;
  const ends = chains.flatMap((street) => [0, street.length - 1].map((i) => ({
    street, i, p: street[i]!, degree: degree(chains, street[i]!),
  })));
  let best: StreetPoint | undefined;
  let reach = radius;
  for (const end of ends) {
    const d = distance(end.p, point);
    if (end.degree === 1 && !isPortal(end.p) && d <= reach) {
      const adjacent = end.i === 0 ? 1 : end.i - 1;
      best = { kind: 'tip', street: end.street, point: end.p, tangent: normalize(sub(end.p, end.street[adjacent]!)) };
      reach = d;
    }
  }
  if (best) return best;
  for (const chain of chains) {
    for (let i = 1; i < chain.length; i++) {
      const p = projectOntoSegment(point, chain[i - 1]!, chain[i]!);
      const d = distance(p, point);
      if (d > reach || !insideMeadow(p)) continue;
      if (ends.some((end) => distance(p, end.p) < (end.degree >= 3 ? 23 : 12))) continue;
      const j = i > 1 && same(p, chain[i - 1]!) ? i - 1 : i;
      best = { kind: 'street', street: chain, point: p, tangent: normalize(sub(chain[j]!, chain[j - 1]!)) };
      reach = d;
    }
  }
  return best;
}

export function meadowScenario(roads: readonly MeadowRoad[] = []): Scenario {
  const { network, demand } = buildStreetNetwork(new NetworkBuilder(), meadowStreets(roads), PORTALS);
  const decor = scenery();
  const driveways = new NetworkBuilder();
  for (const house of decor.houses) {
    const streetY = house.x < 0 ? -8 : 8;
    const side = Math.sign(house.y - streetY);
    const x = house.x - 4;
    driveways.addSurface('driveway', polyline([
      { x, y: streetY + side * (WIDTH / 2 - 0.5) },
      { x, y: house.y - side * 3.5 },
    ]), 2.6);
  }
  for (const surface of driveways.build().surfaces) network.surfaces.push({ ...surface, id: network.surfaces.length });
  return { name: 'meadow', network, demand, bounds: { ...BOUNDS }, decor };
}

function pointSegmentDistance(p: Vec2, a: Vec2, b: Vec2): number {
  return distance(p, projectOntoSegment(p, a, b));
}

function blockedByScenery(p: Vec2, decor: Decor): boolean {
  if ([...decor.lakes, ...decor.hills].some((blob) => distance(p, blob) < blob.radius * 1.3 + WIDTH / 2 + 2)) return true;
  return decor.houses.some((house) => {
    const garden = house.garden;
    if (garden && p.x >= garden.minX - WIDTH / 2 && p.x <= garden.maxX + WIDTH / 2
      && p.y >= garden.minY - WIDTH / 2 && p.y <= garden.maxY + WIDTH / 2) return true;
    const d = sub(p, house);
    const x = d.x * Math.cos(house.angle) + d.y * Math.sin(house.angle);
    const y = -d.x * Math.sin(house.angle) + d.y * Math.cos(house.angle);
    return Math.abs(x) < 12 && Math.abs(y) < 12;
  });
}

function insideMeadow(p: Vec2): boolean {
  const margin = WIDTH / 2 + 2;
  return p.x >= BOUNDS.minX + margin && p.x <= BOUNDS.maxX - margin
    && p.y >= BOUNDS.minY + margin && p.y <= BOUNDS.maxY - margin;
}

type Attachment = { kind: 'tip'; direction: Vec2 } | { kind: 'street'; direction: Vec2 };

function attachment(chains: Vec2[][], p: Vec2, toward: Vec2): Attachment | undefined {
  if (isPortal(p) || degree(chains, p) >= 3) return undefined;
  for (const c of chains) {
    if (same(tip(c), p)) return { kind: 'tip', direction: normalize(sub(p, c[c.length - 2]!)) };
    if (same(c[0]!, p)) return { kind: 'tip', direction: normalize(sub(p, c[1]!)) };
  }
  for (const c of chains) {
    for (let i = 1; i < c.length; i++) {
      if (pointSegmentDistance(p, c[i - 1]!, c[i]!) > 1e-6) continue;
      if (chains.some((chain) => [chain[0]!, tip(chain)].some((end) =>
        distance(p, end) < (degree(chains, end) >= 3 ? 23 : 12)))) return undefined;
      const along = normalize(sub(c[i]!, c[i - 1]!));
      const normal = { x: -along.y, y: along.x };
      const outward = dot(normal, toward) >= 0 ? normal : scale(normal, -1);
      const direction = Math.abs(dot(along, toward)) <= Math.SQRT1_2
        ? toward : normalize(add(outward, scale(along, Math.sign(dot(along, toward)))));
      return { kind: 'street', direction };
    }
  }
  return undefined;
}

function curve(start: Vec2, end: Vec2, incoming: Vec2, outgoing: Vec2): Vec2[] {
  const handle = distance(start, end) / 3;
  return [start, ...cubicPoints(
    add(start, scale(incoming, TANGENT_LEAD)), add(start, scale(incoming, handle)),
    sub(end, scale(outgoing, handle)), sub(end, scale(outgoing, TANGENT_LEAD)), 0.6,
  ), end];
}

export function planMeadowRoad(roads: readonly MeadowRoad[], start: Vec2, end: Vec2, bend?: Vec2): Plan {
  const fail = (reason: string): Plan => ({ ok: false, reason });
  if (![start, end, ...(bend ? [bend] : [])].every((p) => Number.isFinite(p.x) && Number.isFinite(p.y))) return fail('Choose a point inside the meadow.');
  if (!insideMeadow(start) || !insideMeadow(end) || (bend && !insideMeadow(bend))) return fail('Keep the whole street inside the meadow.');
  const chains = meadowStreets(roads);
  const chord = normalize(sub(end, start));
  const source = attachment(chains, start, normalize(sub(bend ?? end, start)));
  if (!source) return fail('Start at a street tip or an open stretch of street.');
  const target = attachment(chains, end, normalize(sub(bend ?? start, end)));
  const endOnStreet = chains.some((c) => c.slice(1).some((b, i) => pointSegmentDistance(end, c[i]!, b) < 1e-6));
  if (endOnStreet && !target) return fail('Leave room between junctions and street ends.');
  if (source.kind === 'street' && target?.kind === 'street' && distance(start, end) < 23) return fail('Leave room between junctions and street ends.');
  if (!target && distance(start, end) < MIN_LENGTH) return fail('Build at least 12 metres of street.');
  const outgoing = target ? scale(target.direction, -1) : normalize(sub(end, bend ?? start));
  const firstChord = normalize(sub(bend ?? end, start));
  const lastChord = normalize(sub(end, bend ?? start));
  if (dot(firstChord, source.direction) < (source.kind === 'tip' ? 0.45 : Math.SQRT1_2)
    || dot(lastChord, outgoing) < (target?.kind === 'street' ? Math.SQRT1_2 : 0.45)) return fail('Extend the road in its direction of travel.');
  if (bend && (distance(start, bend) < MIN_LENGTH || distance(end, bend) < MIN_LENGTH)) return fail('Give the curve more room.');
  const bendHeading = chord;
  const points = bend
    ? [...curve(start, bend, source.direction, bendHeading), ...curve(bend, end, bendHeading, outgoing).slice(1)]
    : curve(start, end, source.direction, outgoing);
  const path = polyline(points);
  for (let i = 1; i < points.length - 1; i++) {
    const a = sub(points[i]!, points[i - 1]!);
    const b = sub(points[i + 1]!, points[i]!);
    const turn = Math.acos(Math.max(-1, Math.min(1, dot(normalize(a), normalize(b)))));
    if (turn > (distance(points[i - 1]!, points[i + 1]!) / 2) / MIN_RADIUS) return fail('That bend is too tight. Try a longer, gentler curve.');
  }
  const decor = scenery();
  const joins = target ? [start, end] : [start];
  for (const p of points) {
    if (!insideMeadow(p)) return fail('Keep the whole street inside the meadow.');
    if (blockedByScenery(p, decor)) return fail('Leave room around buildings, water and hills.');
    for (const chain of chains) {
      for (let j = 1; j < chain.length; j++) {
        const closest = projectOntoSegment(p, chain[j - 1]!, chain[j]!);
        const joining = joins.some((join) =>
          distance(closest, join) <= 12 && distance(p, join) <= 16);
        if (!joining && distance(p, closest) < WIDTH + 1) return fail('Leave space between streets or snap to the street.');
      }
    }
  }
  const lengths = path.cum;
  for (let i = 0; i < points.length; i++) {
    for (let j = i + 2; j < points.length; j++) {
      if (lengths[j]! - lengths[i]! > 24 && distance(points[i]!, points[j]!) < WIDTH + 1) return fail('Leave space between streets.');
    }
  }
  return { ok: true, road: { points }, path };
}
