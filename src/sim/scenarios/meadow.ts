import { cubicPoints } from '../math/curves';
import { polyline, type Polyline } from '../math/polyline';
import { add, distance, dot, normalize, perp, projectOntoSegment, scale, sub, type Vec2 } from '../math/vec';
import type { StreetPoint } from '../network/angleSnap';
import { compactEndConnection, roundedJunctionCorner } from '../network/endConnection';
import { NetworkBuilder } from '../network/builder';
import { streetCrossings, throughArms, type StreetCrossing } from '../network/junctions';
import { buildStreetNetwork } from '../network/streets';
import type { Bounds, Decor, House, Scenario } from './types';

export interface MeadowRoad {
  readonly points: readonly Vec2[];
  readonly fourWays?: readonly StreetCrossing[];
}

export type MeadowEdit = MeadowRoad | { readonly remove: number };
type RemovedArm = Pick<StreetPoint, 'point' | 'tangent'>;

type Plan = { ok: true; road: MeadowRoad; path: Polyline } | { ok: false; reason: string; points?: readonly Vec2[] };
const WIDTH = 8;
export { WIDTH as MEADOW_ROAD_WIDTH };
const TANGENT_LEAD = 0.25;
const MIN_LENGTH = 12;
const MIN_JUNCTION_SPACING = 23;
const MIN_RADIUS = 18;
/** cos 120°, nudged so a drag snapped to exactly 120° still counts. */
const MAX_CORNER_TURN = -0.5 - 1e-9;
/** Matches the coalescing threshold: a gentler corner would merge into one kinked street without a connector. */
const SMOOTH_NODE = 0.95;
const BOUNDS: Bounds = { minX: -180, maxX: 180, minY: -115, maxY: 115 };
const BUILD_MARGIN = WIDTH / 2 + 2;
export const MEADOW_BUILD_BOUNDS: Bounds = {
  minX: BOUNDS.minX + BUILD_MARGIN, maxX: BOUNDS.maxX - BUILD_MARGIN,
  minY: BOUNDS.minY + BUILD_MARGIN, maxY: BOUNDS.maxY - BUILD_MARGIN,
};

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

function splitAt(original: Vec2[], node: Vec2): Vec2[][] {
  const chain = original.map((p) => same(p, node) ? node : p);
  if (same(chain[0]!, node) || same(tip(chain), node)) return [chain];
  for (let i = 1; i < chain.length; i++) {
    if (pointSegmentDistance(node, chain[i - 1]!, chain[i]!) >= 1e-6) continue;
    const before = chain.slice(0, i);
    const after = chain.slice(i);
    if (!same(tip(before), node)) before.push(node);
    if (!same(after[0]!, node)) after.unshift(node);
    return [before, after];
  }
  return [chain];
}

export function meadowRoadSections(road: MeadowRoad): Vec2[][] {
  let sections = [[...road.points]];
  for (const { point } of road.fourWays ?? []) sections = sections.flatMap((section) => splitAt(section, point));
  return sections;
}

function removable(chain: readonly Vec2[]): boolean {
  return !isPortal(chain[0]!) && !isPortal(tip(chain));
}

/** Keep construction boundaries so each bulldozer edit removes one reproducible section. */
function replayMeadow(edits: readonly MeadowEdit[]): { chains: Vec2[][]; crossings: StreetCrossing[]; removedArms: RemovedArm[] } {
  let chains: Vec2[][] = [
    [PORTALS[0]!, { x: MEADOW_BUILD_BOUNDS.minX, y: -8 }],
    [{ x: MEADOW_BUILD_BOUNDS.minX, y: -8 }, { x: -45, y: -8 }],
    [PORTALS[1]!, { x: MEADOW_BUILD_BOUNDS.maxX, y: 8 }],
    [{ x: MEADOW_BUILD_BOUNDS.maxX, y: 8 }, { x: 45, y: 8 }],
  ];
  const crossings: StreetCrossing[] = [];
  const removedArms: RemovedArm[] = [];
  for (const edit of edits) {
    if ('remove' in edit) {
      const selected = chains.filter(removable)[edit.remove];
      if (selected) {
        removedArms.push(
          { point: selected[0]!, tangent: normalize(sub(selected[1]!, selected[0]!)) },
          { point: tip(selected), tangent: normalize(sub(selected[selected.length - 2]!, tip(selected))) },
        );
        chains.splice(chains.indexOf(selected), 1);
      }
      continue;
    }
    const endpoints = [edit.points[0]!, tip(edit.points)];
    for (const node of [...endpoints, ...(edit.fourWays ?? []).map((c) => c.point)]) {
      chains = chains.flatMap((chain) => splitAt(chain, node));
    }
    chains.push(...meadowRoadSections(edit));
    crossings.push(...(edit.fourWays ?? []));
  }
  return { chains, crossings, removedArms };
}

export function meadowSegments(edits: readonly MeadowEdit[]): readonly (readonly Vec2[])[] {
  return replayMeadow(edits).chains.filter(removable);
}

/** Coalesce smooth degree-two nodes while preserving sharp corners for lane connectors. */
export function meadowStreets(edits: readonly MeadowEdit[]): Vec2[][] {
  return coalesceStreets(replayMeadow(edits).chains);
}

function coalesceStreets(chains: Vec2[][]): Vec2[][] {
  for (let i = 0; i < chains.length; i++) {
    let merged = false;
    for (const endpoint of [chains[i]![0]!, tip(chains[i]!)]) {
      if (degree(chains, endpoint) !== 2) continue;
      const j = chains.findIndex((chain, index) => index !== i && (same(chain[0]!, endpoint) || same(tip(chain), endpoint)));
      if (j < 0) continue;
      const first = same(tip(chains[i]!), endpoint) ? chains[i]! : [...chains[i]!].reverse();
      const second = same(chains[j]![0]!, endpoint) ? chains[j]! : [...chains[j]!].reverse();
      const incoming = normalize(sub(endpoint, first[first.length - 2]!));
      const outgoing = normalize(sub(second[1]!, endpoint));
      if (dot(incoming, outgoing) < 0.95) continue;
      chains[i] = [...first, ...second.slice(1)];
      chains.splice(j, 1);
      merged = true;
      break;
    }
    if (merged) i = -1;
  }
  return chains;
}

function degree(chains: readonly (readonly Vec2[])[], p: Vec2): number {
  return chains.reduce((sum, c) => sum + Number(same(c[0]!, p)) + Number(same(tip(c), p)), 0);
}

function streetTips(chains: Vec2[][]): Vec2[] {
  return chains.flatMap((c) => [c[0]!, tip(c)])
    .filter((p) => !isPortal(p) && degree(chains, p) === 1).map((p) => ({ ...p }));
}

function portalsConnected(chains: Vec2[][]): boolean {
  const reached: Vec2[] = [PORTALS[0]!];
  for (let i = 0; i < reached.length; i++) {
    for (const chain of chains) {
      if (same(chain[0]!, reached[i]!) && !reached.some((p) => same(p, tip(chain)))) reached.push(tip(chain));
      if (same(tip(chain), reached[i]!) && !reached.some((p) => same(p, chain[0]!))) reached.push(chain[0]!);
    }
  }
  return reached.some((p) => same(p, PORTALS[1]!));
}

export function meadowTips(edits: readonly MeadowEdit[]): Vec2[] {
  return streetTips(meadowStreets(edits));
}

export function meadowConnected(edits: readonly MeadowEdit[]): boolean {
  return portalsConnected(meadowStreets(edits));
}

export function meadowLayout(edits: readonly MeadowEdit[]) {
  const { chains } = replayMeadow(edits);
  const segments = chains.filter(removable);
  const streets = coalesceStreets(chains);
  return { segments, streets, tips: streetTips(streets), connected: portalsConnected(streets) };
}

export function meadowSnap(roads: readonly MeadowEdit[], point: Vec2, radius: number): Vec2 | undefined {
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
    if (d > reach || isPortal(end.p)) continue;
    if (end.degree === 2) {
      const tangents = ends.filter((arm) => same(arm.p, end.p)).map((arm) =>
        normalize(sub(arm.street[arm.i === 0 ? 1 : arm.i - 1]!, arm.p)));
      best = { kind: 'corner', street: end.street, point: end.p, tangent: scale(tangents[0]!, -1), tangents };
      reach = d;
    } else if (end.degree === 3) {
      const arms = ends.filter((arm) => same(arm.p, end.p)).map((arm) => ({
        street: arm.street,
        tangent: normalize(sub(arm.street[arm.i === 0 ? 1 : arm.i - 1]!, arm.p)),
      }));
      const main = throughArms(arms);
      const side = arms.find((arm) => !main.includes(arm))!;
      best = { kind: 'junction', street: side.street, point: end.p, tangent: scale(side.tangent, -1), priorityAxis: main[0]!.tangent };
      reach = d;
    } else if (end.degree === 1) {
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
      if (ends.some((end) => distance(p, end.p) < (end.degree >= 3 ? MIN_JUNCTION_SPACING : MIN_LENGTH))) continue;
      const j = i > 1 && same(p, chain[i - 1]!) ? i - 1 : i;
      best = { kind: 'street', segmentEnd: j, street: chain, point: p, tangent: normalize(sub(chain[j]!, chain[j - 1]!)) };
      reach = d;
    }
  }
  return best;
}

export function meadowScenario(roads: readonly MeadowEdit[] = []): Scenario {
  const replay = replayMeadow(roads);
  const streets = coalesceStreets(replay.chains);
  const crossings = replay.crossings.filter((crossing) => degree(streets, crossing.point) === 4);
  const { network, demand } = buildStreetNetwork(new NetworkBuilder(), streets, PORTALS, crossings);
  const decor = scenery();
  const driveways = new NetworkBuilder();
  for (const house of decor.houses) {
    const streetY = house.x < 0 ? -8 : 8;
    if (!streets.some((street) => containsPoint(street, { x: house.x - 4, y: streetY }))) continue;
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

function containsPoint(chain: readonly Vec2[], p: Vec2): boolean {
  return chain.some((b, i) => i > 0 && pointSegmentDistance(p, chain[i - 1]!, b) < 1e-6);
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
  return p.x >= MEADOW_BUILD_BOUNDS.minX && p.x <= MEADOW_BUILD_BOUNDS.maxX
    && p.y >= MEADOW_BUILD_BOUNDS.minY && p.y <= MEADOW_BUILD_BOUNDS.maxY;
}

function departure(snap: StreetPoint | undefined, toward: Vec2, removedArms: readonly RemovedArm[]): Vec2 {
  if (!snap) return toward;
  if (snap.kind === 'corner') {
    return snap.tangents.map((tangent) => scale(tangent, -1)).reduce((best, tangent) =>
      dot(tangent, toward) > dot(best, toward) ? tangent : best);
  }
  if (snap.kind === 'tip') {
    const restored = removedArms.filter((arm) => same(arm.point, snap.point)
      && Math.abs(dot(snap.tangent, arm.tangent)) < Math.SQRT1_2
      && dot(arm.tangent, toward) >= Math.cos(5 * Math.PI / 180))
      .sort((a, b) => dot(b.tangent, toward) - dot(a.tangent, toward))[0];
    if (restored) return restored.tangent;
  }
  if (snap.kind !== 'street') return snap.tangent;
  const along = snap.tangent;
  if (Math.abs(dot(along, toward)) <= Math.SQRT1_2) return toward;
  const normal = { x: -along.y, y: along.x };
  const outward = dot(normal, toward) >= 0 ? normal : scale(normal, -1);
  return normalize(add(outward, scale(along, Math.sign(dot(along, toward)))));
}

function endJoin(source: StreetPoint | undefined, target: StreetPoint | undefined, chord: Vec2, decor: Decor): Vec2[] | undefined {
  if (!source || !target) return undefined;
  if (source.kind === 'tip' && target.kind === 'tip') {
    const outgoing = scale(target.tangent, -1);
    const fits = (points: Vec2[]) => points.every((p) => insideMeadow(p) && !blockedByScenery(p, decor));
    if (dot(source.tangent, chord) >= 0.45 && dot(outgoing, chord) >= 0.45) {
      const straight = dot(source.tangent, chord) > 1 - 1e-10 && dot(outgoing, chord) > 1 - 1e-10;
      const count = Math.max(1, Math.ceil(distance(source.point, target.point) / 0.6));
      const gentle = straight
        ? Array.from({ length: count + 1 }, (_, i) => add(source.point, scale(sub(target.point, source.point), i / count)))
        : curve(source.point, target.point, source.tangent, outgoing);
      if (!hasTightBend(gentle) && fits(gentle)) return gentle;
    }
    const preferred = compactEndConnection(source.point, target.point, source.tangent, outgoing);
    if (preferred && fits(preferred)) return preferred;
    const minimum = compactEndConnection(source.point, target.point, source.tangent, outgoing, 10);
    return minimum ?? preferred;
  }
  const tipFirst = source.kind === 'tip' && target.kind === 'street';
  if (!tipFirst && !(source.kind === 'street' && target.kind === 'tip')) return undefined;
  const side = tipFirst ? target : source;
  const tip = tipFirst ? source : target;
  const normal = perp(side.tangent);
  if (Math.abs(dot(tip.tangent, normal)) >= Math.sin(5 * Math.PI / 180)) return undefined;
  const across = dot(chord, normal) >= 0 ? normal : scale(normal, -1);
  const incoming = tipFirst ? tip.tangent : across;
  const outgoing = tipFirst ? across : scale(tip.tangent, -1);
  return roundedJunctionCorner(source.point, target.point, incoming, outgoing, MIN_RADIUS);
}

function curve(start: Vec2, end: Vec2, incoming: Vec2, outgoing: Vec2): Vec2[] {
  const handle = distance(start, end) / 3;
  return [start, ...cubicPoints(
    add(start, scale(incoming, TANGENT_LEAD)), add(start, scale(incoming, handle)),
    sub(end, scale(outgoing, handle)), sub(end, scale(outgoing, TANGENT_LEAD)), 0.6,
  ), end];
}

function hasTightBend(points: readonly Vec2[]): boolean {
  for (let i = 1; i < points.length - 1; i++) {
    const a = sub(points[i]!, points[i - 1]!);
    const b = sub(points[i + 1]!, points[i]!);
    const turn = Math.acos(Math.max(-1, Math.min(1, dot(normalize(a), normalize(b)))));
    if (turn > (distance(points[i - 1]!, points[i + 1]!) / 2) / MIN_RADIUS) return true;
  }
  return false;
}

/** Headings the road may take at one end. A free tip can also leave along the drag as a sharp
 * corner node (`tipHeading` points along the old street into the node); the network gives it a mouth connector. */
function endHeadings(drag: Vec2, smooth: Vec2, threshold: number, tipHeading?: Vec2): Vec2[] {
  const headings = dot(drag, smooth) >= threshold ? [smooth] : [];
  const turn = tipHeading ? dot(tipHeading, drag) : 1;
  if (turn >= MAX_CORNER_TURN && turn < SMOOTH_NODE) headings.push(drag);
  return headings;
}

type Shape = { points: Vec2[]; rounded: boolean; corners: readonly [boolean, boolean] } | { reason: string };

function* roadShapes(
  source: StreetPoint | undefined, target: StreetPoint | undefined, start: Vec2, end: Vec2, bend: Vec2 | undefined,
  removedArms: readonly RemovedArm[], decor: Decor,
): Generator<Shape> {
  const rounded = bend ? undefined : endJoin(source, target, normalize(sub(end, start)), decor);
  if (rounded) yield { points: rounded, rounded: true, corners: [false, false] };
  const firstChord = normalize(sub(bend ?? end, start));
  const lastChord = normalize(sub(end, bend ?? start));
  const departing = departure(source, firstChord, removedArms);
  const arriving = scale(departure(target, scale(lastChord, -1), removedArms), -1);
  const fromTip = source?.kind === 'tip';
  const toTip = target?.kind === 'tip';
  const starts = endHeadings(firstChord, departing, fromTip ? 0.45 : Math.SQRT1_2, fromTip ? source.tangent : undefined);
  const ends = endHeadings(lastChord, arriving, toTip ? 0.45 : Math.SQRT1_2, toTip ? scale(target.tangent, -1) : undefined);
  if (!starts.length || !ends.length) {
    const corner = (!starts.length && fromTip) || (!ends.length && toTip);
    yield { reason: fromTip && toTip
      ? 'Leave more room between the road ends for a rounded turn.'
      : corner ? 'That corner is too sharp. Turn by at most 120°.' : 'Extend the road in its direction of travel.' };
  }
  const bendHeading = normalize(sub(end, start));
  for (const incoming of starts) {
    for (const outgoing of ends) {
      const corners = [incoming !== departing, outgoing !== arriving] as const;
      const points = bend
        ? [...curve(start, bend, incoming, bendHeading), ...curve(bend, end, bendHeading, outgoing).slice(1)]
        : curve(start, end, incoming, outgoing);
      yield { points, rounded: false, corners };
    }
  }
}

export function planMeadowRoad(roads: readonly MeadowEdit[], start: Vec2, end: Vec2, bend?: Vec2): Plan {
  const fail = (reason: string): Plan => ({ ok: false, reason });
  if (![start, end, ...(bend ? [bend] : [])].every((p) => Number.isFinite(p.x) && Number.isFinite(p.y))) return fail('Choose a point inside the meadow.');
  if (!insideMeadow(start) || !insideMeadow(end) || (bend && !insideMeadow(bend))) return fail('Keep the whole street inside the meadow.');
  const replay = replayMeadow(roads);
  const chains = coalesceStreets(replay.chains);
  const source = snapToMeadowStreet(chains, start, 1e-6);
  const target = snapToMeadowStreet(chains, end, 1e-6);
  const onStreet = (p: Vec2) => chains.some((chain) => containsPoint(chain, p));
  if ((!source && onStreet(start)) || (!target && onStreet(end))) return fail('Leave room between junctions and street ends.');
  if ((!target || !source) && distance(start, end) < MIN_LENGTH) return fail('Build at least 12 metres of street.');
  if (bend && (distance(start, bend) < MIN_LENGTH || distance(end, bend) < MIN_LENGTH)) return fail('Give the curve more room.');
  const decor = scenery();
  let rejected: Plan | undefined;
  for (const shape of roadShapes(source, target, start, end, bend, replay.removedArms, decor)) {
    const plan = 'reason' in shape ? fail(shape.reason) : checkRoad(chains, source, target, shape, decor);
    if (plan.ok) return plan;
    rejected ??= plan;
  }
  return rejected!;
}

function checkRoad(
  chains: Vec2[][], source: StreetPoint | undefined, target: StreetPoint | undefined,
  { points, rounded, corners }: Extract<Shape, { points: Vec2[] }>, decor: Decor,
): Plan {
  const fail = (reason: string): Plan => ({ ok: false, reason });
  const start = points[0]!;
  const end = tip(points);
  const startsAtNode = (source && source.kind !== 'tip') || corners[0];
  const endsAtNode = (target && target.kind !== 'tip') || corners[1];
  if (startsAtNode && endsAtNode && distance(start, end) < MIN_JUNCTION_SPACING) return fail('Leave room between junctions and street ends.');
  const path = polyline(points);
  if (!rounded && hasTightBend(points)) return fail('That bend is too tight. Try a longer, gentler curve.');
  for (const p of points) {
    if (!insideMeadow(p)) return { ok: false, points, reason: source?.kind === 'tip' && target?.kind === 'tip'
      ? 'This bend would leave the meadow. Move the road ends farther from the edge.' : 'Keep the whole street inside the meadow.' };
    if (blockedByScenery(p, decor)) return fail('Leave room around buildings, water and hills.');
  }
  const intersections = streetCrossings(points, chains);
  if (!intersections.ok) return intersections;
  const { crossings } = intersections;
  for (const { point } of crossings) {
    const nearEndpoint = distance(point, start) < (startsAtNode ? MIN_JUNCTION_SPACING : MIN_LENGTH)
      || distance(point, end) < (endsAtNode ? MIN_JUNCTION_SPACING : MIN_LENGTH);
    const nearOldNode = chains.some((chain) => [chain[0]!, tip(chain)].some((p) =>
      distance(point, p) < (degree(chains, p) >= 3 ? MIN_JUNCTION_SPACING : MIN_LENGTH)));
    const nearOtherCrossing = crossings.some((other) => other.point !== point && distance(point, other.point) < MIN_JUNCTION_SPACING);
    if (nearEndpoint || nearOldNode || nearOtherCrossing) {
      return fail('Leave room between crossings, junctions and street ends.');
    }
  }
  const joins = [...(source ? [start] : []), ...(target ? [end] : []), ...crossings.map((c) => c.point)];
  for (const chain of chains) {
    const attached = joins.filter((join) => containsPoint(chain, join));
    for (const p of points) {
      for (let j = 1; j < chain.length; j++) {
        const closest = projectOntoSegment(p, chain[j - 1]!, chain[j]!);
        const joining = attached.some((join) =>
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
  const fourWays = [...crossings];
  for (const snap of [source, target]) {
    if (snap?.kind === 'junction') fourWays.push({ point: snap.point, priorityAxis: snap.priorityAxis });
  }
  return { ok: true, road: fourWays.length ? { points, fourWays } : { points }, path };
}
