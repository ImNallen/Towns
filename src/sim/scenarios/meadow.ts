import { cubicPoints } from '../math/curves';
import { polyline, type Polyline } from '../math/polyline';
import { add, distance, dot, fromAngle, normalize, perp, projectOntoSegment, scale, sub, type Vec2 } from '../math/vec';
import type { StreetPoint } from '../network/angleSnap';
import { compactEndConnection, roundedJunctionCorner } from '../network/endConnection';
import { NetworkBuilder } from '../network/builder';
import { streetCrossings, throughArms, type StreetCrossing } from '../network/junctions';
import { edgeOffset, ROAD_TYPES, type RoadType } from '../network/roadTypes';
import { buildStreetNetwork } from '../network/streets';
import type { Network } from '../network/types';
import { ECONOMY } from '../town/economy';
import type { AccessPoint } from '../traffic/routing';
import { cellsAlong, buildZoneCells, type CellKey, type RoadIndex, type ZoneCells, type ZoneRoad } from '../zoning/cells';
import type { LandUse, ZoneStroke, Zoning } from '../zoning/paint';
import type { Bounds, Decor, House, RegionSpec, Scenario } from './types';

export interface MeadowRoad {
  readonly roadType?: RoadType;
  readonly points: readonly Vec2[];
  readonly fourWays?: readonly StreetCrossing[];
}

export interface WalkEdit { walk: "footpath" | "zebra"; a: Vec2; b: Vec2 }
export type MeadowEdit = { lights: Vec2; actuated?: boolean } | WalkEdit | MeadowRoad | { readonly remove: number } | { readonly upgrade: number; readonly roadType: RoadType } | ZoneStroke;

export const isZoneStroke = (edit: MeadowEdit): edit is ZoneStroke => 'zone' in edit;

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
/**
 * The towns behind the West and East portals. Westbrook has a few modest jobs; Eastford has
 * plenty of better-paid ones, so connecting the neighbourhoods raises West incomes.
 */
const REGIONS: readonly Omit<RegionSpec, 'sink' | 'source'>[] = [
  { name: 'Westbrook', wage: ECONOMY.westbrookWage, jobs: 4, groceryPrice: ECONOMY.regionalGroceryPrice },
  { name: 'Eastford', wage: ECONOMY.eastfordWage, jobs: 14, groceryPrice: ECONOMY.regionalGroceryPrice },
];
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

/** A chain and the arc-length range [from, to] it covers on the road it was built as. */
interface Section {
  roadType: RoadType;
  readonly points: Vec2[];
  readonly road: RoadIndex;
  readonly from: number;
  readonly to: number;
}

function splitSection(section: Section, node: Vec2): Section[] {
  const parts = splitAt(section.points, node);
  if (parts.length === 1) return [{ ...section, points: parts[0]! }];
  const middle = section.from + polyline(parts[0]!).length;
  return [
    { ...section, points: parts[0]!, from: section.from, to: middle },
    { ...section, points: parts[1]!, from: middle, to: section.to },
  ];
}

function roadSections(road: MeadowRoad, index: RoadIndex): Section[] {
  let sections: Section[] = [{ roadType: road.roadType ?? 'town', points: [...road.points], road: index, from: 0, to: polyline(road.points).length }];
  for (const { point } of road.fourWays ?? []) sections = sections.flatMap((section) => splitSection(section, point));
  return sections;
}

export function meadowRoadSections(road: MeadowRoad): Vec2[][] {
  return roadSections(road, 0 as RoadIndex).map((section) => section.points);
}

function removable(chain: readonly Vec2[]): boolean {
  return !isPortal(chain[0]!) && !isPortal(tip(chain));
}

const STARTER_ROADS: readonly (readonly Vec2[])[] = [
  [PORTALS[0]!, { x: MEADOW_BUILD_BOUNDS.minX, y: -8 }],
  [{ x: MEADOW_BUILD_BOUNDS.minX, y: -8 }, { x: -45, y: -8 }],
  [PORTALS[1]!, { x: MEADOW_BUILD_BOUNDS.maxX, y: 8 }],
  [{ x: MEADOW_BUILD_BOUNDS.maxX, y: 8 }, { x: 45, y: 8 }],
];

interface Replay {
  chains: Vec2[][];
  /** Parallel to `chains`. */
  sections: Section[];
  roads: (readonly Vec2[] | undefined)[];
  crossings: StreetCrossing[];
  removedArms: RemovedArm[];
}

/** Keep construction boundaries so each bulldozer edit removes one reproducible section. */
function replayMeadow(edits: readonly MeadowEdit[]): Replay {
  let sections: Section[] = STARTER_ROADS.map((points, road) => ({
    roadType: 'town', points: [...points], road: road as RoadIndex, from: 0, to: polyline(points).length,
  }));
  const roads: (readonly Vec2[] | undefined)[] = [...STARTER_ROADS];
  const crossings: StreetCrossing[] = [];
  const removedArms: RemovedArm[] = [];
  for (const edit of edits) {
    if (isZoneStroke(edit) || 'walk' in edit || 'lights' in edit) {
      roads.push(undefined);
      continue;
    }
    if ('upgrade' in edit) {
      roads.push(undefined);
      const selected = sections.filter(section => removable(section.points))[edit.upgrade];
      if (selected) selected.roadType = edit.roadType;
      continue;
    }
    if ('remove' in edit) {
      roads.push(undefined);
      const selected = sections.filter((section) => removable(section.points))[edit.remove];
      if (selected) {
        const chain = selected.points;
        removedArms.push(
          { point: chain[0]!, tangent: normalize(sub(chain[1]!, chain[0]!)) },
          { point: tip(chain), tangent: normalize(sub(chain[chain.length - 2]!, tip(chain))) },
        );
        sections.splice(sections.indexOf(selected), 1);
      }
      continue;
    }
    const endpoints = [edit.points[0]!, tip(edit.points)];
    for (const node of [...endpoints, ...(edit.fourWays ?? []).map((c) => c.point)]) {
      sections = sections.flatMap((section) => splitSection(section, node));
    }
    sections.push(...roadSections(edit, roads.length as RoadIndex));
    roads.push(edit.points);
    crossings.push(...(edit.fourWays ?? []));
  }
  return { chains: sections.map((section) => section.points), sections, roads, crossings, removedArms };
}

/** Each built road with the arc-length spans of it still standing, in construction order. */
function zoneRoads({ roads, sections }: Replay): ZoneRoad[] {
  const out: ZoneRoad[] = [];
  for (const [index, points] of roads.entries()) {
    if (!points) continue;
    const ranges = sections.filter((s) => s.road === index).sort((a, b) => a.from - b.from);
    const spans: [number, number][] = [];
    for (const { from, to } of ranges) {
      const last = spans.at(-1);
      if (last && from <= last[1] + 1e-6) last[1] = Math.max(last[1], to);
      else spans.push([from, to]);
    }
    if (spans.length) out.push({ index: index as RoadIndex, points, spans, ranges });
  }
  return out;
}

export function meadowZoning(edits: readonly MeadowEdit[], cells: ZoneCells): Zoning {
  const named = new Map<CellKey, LandUse | null>();
  for (const edit of edits) {
    if (isZoneStroke(edit)) for (const key of edit.cells) named.set(key, edit.zone);
  }
  const zoning = new Map<CellKey, LandUse>();
  if (named.size === 0) return zoning;
  for (let i = 0; i < cells.count; i++) {
    const key = cells.keys[i]! as CellKey;
    const zone = named.get(key);
    if (zone) zoning.set(key, zone);
  }
  return zoning;
}

export function meadowSegmentInfo(edits: readonly MeadowEdit[]) {
  return replayMeadow(edits).sections.filter(s => removable(s.points));
}

export function upgradeFailure(edits: readonly MeadowEdit[], index: number, type: RoadType): string | undefined {
  const sections = replayMeadow(edits).sections;
  const selected = sections.filter(s => removable(s.points))[index];
  if (!selected) return 'Select a street segment.';
  if (selected.roadType === type) return 'This segment already has that road type.';
  const half = edgeOffset(type, 'left');
  if (half <= edgeOffset(selected.roadType, 'left')) return;
  for (const other of sections) {
    if (other === selected) continue;
    const clearance = half + edgeOffset(other.roadType, 'left');
    const joins = [selected.points[0]!, tip(selected.points)].filter(p => same(p, other.points[0]!) || same(p, tip(other.points)));
    // For two non-crossing line segments a closest pair includes an endpoint.
    for (const [a, b] of [[selected.points, other.points], [other.points, selected.points]] as const) {
      for (const p of a) {
        if (joins.some(join => distance(p, join) <= 2 * clearance)) continue;
        if (b.some((q, i) => i > 0 && pointSegmentDistance(p, b[i - 1]!, q) < clearance - 1e-6)) {
          return 'There is too little space beside this segment for the wider road.';
        }
      }
    }
  }
}

export function meadowSegments(edits: readonly MeadowEdit[]): readonly (readonly Vec2[])[] {
  return replayMeadow(edits).chains.filter(removable);
}

/** Coalesce smooth degree-two nodes while preserving sharp corners for lane connectors. */
export function meadowStreets(edits: readonly MeadowEdit[]): Vec2[][] {
  const { chains, sections } = replayMeadow(edits);
  return coalesceStreets(chains, sections.map(s => s.roadType));
}

function coalesceStreets(chains: Vec2[][], types: RoadType[]): Vec2[][] {
  for (let i = 0; i < chains.length; i++) {
    let merged = false;
    for (const endpoint of [chains[i]![0]!, tip(chains[i]!)]) {
      if (degree(chains, endpoint) !== 2) continue;
      const j = chains.findIndex((chain, index) => index !== i && (same(chain[0]!, endpoint) || same(tip(chain), endpoint)));
      if (j < 0 || types[j] !== types[i]) continue;
      const first = same(tip(chains[i]!), endpoint) ? chains[i]! : [...chains[i]!].reverse();
      const second = same(chains[j]![0]!, endpoint) ? chains[j]! : [...chains[j]!].reverse();
      const incoming = normalize(sub(endpoint, first[first.length - 2]!));
      const outgoing = normalize(sub(second[1]!, endpoint));
      if (dot(incoming, outgoing) < 0.95) continue;
      chains[i] = [...first, ...second.slice(1)];
      chains.splice(j, 1);
      types.splice(j, 1);
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
  const { chains, sections } = replayMeadow(edits);
  const segments = chains.filter(removable);
  const streets = coalesceStreets(chains, sections.map(s => s.roadType));
  return { segments, segmentTypes: sections.filter(s => removable(s.points)).map(s => s.roadType), streets, tips: streetTips(streets), connected: portalsConnected(streets) };
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

/** The roads alone, without zone cells: what the editor previews while a road is being placed. */
export function meadowNetwork(roads: readonly MeadowEdit[]): Network {
  return meadowWithoutZones(replayMeadow(roads), roads).network;
}

export function meadowScenario(roads: readonly MeadowEdit[] = []): Scenario {
  const replay = replayMeadow(roads);
  const scenario = meadowWithoutZones(replay, roads);
  for (const edit of roads) {
    if (!('walk' in edit)) continue;
    if (edit.walk === 'footpath') {
      if (crossesCarriageway(scenario.network,edit.a,edit.b)) continue;
      scenario.network.surfaces.push({ style: 'footpath', centerline: polyline([edit.a,edit.b]), width: 1.8, id: scenario.network.surfaces.length });
    } else {
      const crossing = zebraAt(scenario.network, scale(add(edit.a,edit.b),0.5));
      if (!crossing) continue;
      const links = scenario.network.pedestrianLinks!;
      const ordinary = links.find(link => link.crossing && (
        (same(link.a,crossing.a) && same(link.b,crossing.b)) || (same(link.b,crossing.a) && same(link.a,crossing.b))
      ));
      if (ordinary) ordinary.zebra = true;
      else links.push({ a: crossing.a, b: crossing.b, crossing: true, zebra: true });
    }
    scenario.town!.roadUpkeep! += edit.walk === 'zebra' ? 1 : Math.ceil(distance(edit.a,edit.b)*0.07);
  }
  const { lakes, hills } = scenario.decor;
  const zones = buildZoneCells(zoneRoads(replay), {
    surfaces: scenario.network.surfaces,
    blobs: [...lakes, ...hills].map((blob) => ({ x: blob.x, y: blob.y, radius: blob.radius * SCENERY_REACH })),
    bounds: MEADOW_BUILD_BOUNDS,
  });
  zones.gardenCells = Uint8Array.from(zones.keys, (_, i) => {
    const q = zones.corners.subarray(i * 8, i * 8 + 8);
    const xs = [q[0]!, q[2]!, q[4]!, q[6]!], ys = [q[1]!, q[3]!, q[5]!, q[7]!];
    return Number(scenario.decor.houses.some(({ garden: g }) => g && Math.min(...xs) < g.maxX && Math.max(...xs) > g.minX && Math.min(...ys) < g.maxY && Math.max(...ys) > g.minY));
  });
  return { ...scenario, zones };
}

function nearestSurface(network: Network, cursor: Vec2, styles: readonly string[], reach: number) {
  let best: { point: Vec2; tangent: Vec2; type?: RoadType } | undefined;
  for (const s of network.surfaces) {
    if (!styles.includes(s.style)) continue;
    const pts = s.centerline.pts;
    for (let i=2; i<pts.length; i+=2) {
      const a = { x: pts[i-2]!, y: pts[i-1]! }, b = { x: pts[i]!, y: pts[i+1]! };
      const point = projectOntoSegment(cursor,a,b);
      const gap = distance(point,cursor);
      if (gap >= reach) continue;
      reach = gap;
      best = { point, tangent: normalize(sub(b,a)), type: s.roadType };
    }
  }
  return best;
}

function zebraAt(network: Network, cursor: Vec2): WalkEdit | undefined {
  const road = nearestSurface(network,cursor,['twoWay'],5);
  if (!road?.type || road.type === 'country') return;
  const normal = scale(perp(road.tangent),edgeOffset(road.type,'left') - 0.75);
  const a = nearestSurface(network,add(road.point,normal),['pavement'],1);
  const b = nearestSurface(network,sub(road.point,normal),['pavement'],1);
  return a && b ? { walk: 'zebra', a:a.point, b:b.point } : undefined;
}

function crossesCarriageway(network: Network, a: Vec2, b: Vec2): boolean {
  const steps = Math.max(1,Math.ceil(distance(a,b)));
  for (let i=0; i<=steps; i++) {
    const p=add(a,scale(sub(b,a),i/steps));
    if (nearestSurface(network,p,['twoWay','junction'],3.55)) return true;
  }
  return false;
}

export function planWalk(network: Network, walk: WalkEdit['walk'], start: Vec2, end: Vec2, occupied?: { cells: ZoneCells; zoning: Zoning }): WalkEdit | string {
  if (!insideMeadow(start) || !insideMeadow(end)) return 'Stay inside the meadow.';
  if (walk === 'zebra') {
    const crossing = zebraAt(network,end);
    if (!crossing) return 'Choose a street with pavements on both sides.';
    if (network.pedestrianLinks?.some(link => link.zebra && distance(link.a,crossing.a)<5)) return 'There is already a crossing here.';
    return crossing;
  }
  const snap = (p: Vec2) => nearestSurface(network,p,['footpath','pavement'],3)?.point ?? p;
  const a = snap(start), b = snap(end);
  if (occupied && cellsAlong(occupied.cells,a,b).some(key=>occupied.zoning.has(key))) return 'Keep the path on open ground beside the plots.';
  const length = distance(a,b), decor = scenery();
  if (length < 3) return 'Drag a path at least three metres long.';
  if (crossesCarriageway(network,a,b)) return 'Use a crossing to cross the street.';
  for (let i=0; i<=Math.ceil(length); i++) {
    const p = add(a,scale(sub(b,a),i/Math.ceil(length)));
    if (blockedByScenery(p,decor,0.5) && Math.min(distance(p,a),distance(p,b))>2) return 'Keep the path on open ground.';
  }
  return { walk, a, b };
}

function meadowWithoutZones(replay: Replay, edits: readonly MeadowEdit[]): Scenario {
  const types = replay.sections.map(s => s.roadType);
  const streets = coalesceStreets([...replay.chains], types);
  const crossings = replay.crossings.filter((crossing) => degree(streets, crossing.point) === 4);
  const { network, demand, entries } = buildStreetNetwork(new NetworkBuilder(), streets, PORTALS, crossings, types, edits.flatMap(e => 'lights' in e ? [{ ...e.lights, actuated: e.actuated }] : []));
  const decor = scenery();
  const driveways = new NetworkBuilder();
  const homes = decor.houses.map((house) => ({ access: [] as AccessPoint[], region: house.x < 0 ? 0 : 1 }));
  for (const [index, house] of decor.houses.entries()) {
    const streetY = house.x < 0 ? -8 : 8;
    if (!streets.some((street) => containsPoint(street, { x: house.x - 4, y: streetY }))) continue;
    homes[index]!.access = accessPoints(network, { x: house.x - 4, y: streetY });
    const side = Math.sign(house.y - streetY);
    const x = house.x - 4;
    driveways.addSurface('driveway', polyline([
      { x, y: streetY + side * (WIDTH / 2 - 0.5) },
      { x, y: house.y - side * 3.5 },
    ]), 2.6);
  }
  for (const surface of driveways.build().surfaces) network.surfaces.push({ ...surface, id: network.surfaces.length });
  const regions = REGIONS.map((region, i) => ({ ...region, sink: i, source: entries[i]! }));
  const roadMetres = replay.sections.reduce((n, s) => n + (s.to - s.from), 0);
  const roadUpkeep = Math.round(replay.sections.reduce((n, s) => n + (s.to - s.from) * ROAD_TYPES[s.roadType].upkeep, 0));
  return { name: 'meadow', network, demand, bounds: { ...BOUNDS }, decor, town: { homes, regions, roadMetres, roadUpkeep: roadUpkeep + (network.junctions?.filter(j => j.lights).length ?? 0) * 4 } };
}

/** Where a driveway at `p` meets each directional road lane passing it. */
export function accessPoints(network: Network, p: Vec2): AccessPoint[] {
  const access: AccessPoint[] = [];
  for (const lane of network.lanes) {
    if (lane.kind !== 'road') continue;
    const { pts, cum } = lane.path;
    for (let k = 1; k < cum.length; k++) {
      const a = { x: pts[k * 2 - 2]!, y: pts[k * 2 - 1]! };
      const q = projectOntoSegment(p, a, { x: pts[k * 2]!, y: pts[k * 2 + 1]! });
      if (distance(p, q) > 2.5) continue;
      access.push({ lane: lane.id, s: cum[k - 1]! + distance(a, q) });
      break;
    }
  }
  return access;
}

function pointSegmentDistance(p: Vec2, a: Vec2, b: Vec2): number {
  return distance(p, projectOntoSegment(p, a, b));
}

function containsPoint(chain: readonly Vec2[], p: Vec2): boolean {
  return chain.some((b, i) => i > 0 && pointSegmentDistance(p, chain[i - 1]!, b) < 1e-6);
}

/** How far beyond its radius a lake or hill keeps roads and zone cells away. */
const SCENERY_REACH = 1.3;

function blockedByScenery(p: Vec2, decor: Decor, halfWidth = WIDTH / 2): boolean {
  if ([...decor.lakes, ...decor.hills].some((blob) => distance(p, blob) < blob.radius * SCENERY_REACH + halfWidth + 2)) return true;
  return decor.houses.some((house) => {
    const garden = house.garden;
    if (garden && p.x >= garden.minX - halfWidth && p.x <= garden.maxX + halfWidth
      && p.y >= garden.minY - halfWidth && p.y <= garden.maxY + halfWidth) return true;
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

function curve(
  start: Vec2, end: Vec2, incoming: Vec2, outgoing: Vec2, first = distance(start, end) / 3, last = first, step = 0.6,
): Vec2[] {
  return [start, ...cubicPoints(
    add(start, scale(incoming, TANGENT_LEAD)), add(start, scale(incoming, first)),
    sub(end, scale(outgoing, last)), sub(end, scale(outgoing, TANGENT_LEAD)), step,
  ), end];
}

function minRadius(points: readonly Vec2[]): number {
  let radius = Infinity;
  for (let i = 1; i < points.length - 1; i++) {
    const p = points[i - 1]!, q = points[i]!, r = points[i + 1]!;
    const ax = q.x - p.x, ay = q.y - p.y, bx = r.x - q.x, by = r.y - q.y;
    const lengths = Math.sqrt((ax * ax + ay * ay) * (bx * bx + by * by));
    const turn = Math.acos(Math.max(-1, Math.min(1, lengths > 0 ? (ax * bx + ay * by) / lengths : 0)));
    const cx = r.x - p.x, cy = r.y - p.y;
    radius = Math.min(radius, Math.sqrt(cx * cx + cy * cy) / 2 / turn);
  }
  return radius;
}

const hasTightBend = (points: readonly Vec2[]): boolean => minRadius(points) < MIN_RADIUS;

/** Handle lengths as fractions of the chord. A third suits gentle turns; wide arcs need longer handles. */
const HANDLES = [0.25, 0.4, 0.55, 0.7];
const BEND_TURNS = [0, -20, 20, -40, 40].map((degrees) => fromAngle(degrees * Math.PI / 180));
const GENTLE_TRIES = 3;
/** Candidates are ranked on a coarse sampling; only the few that get checked are sampled finely. */
const ROUGH_STEP = 2;

type Cubic = { start: Vec2; end: Vec2; incoming: Vec2; outgoing: Vec2; first: number; last: number };

const rotate = (v: Vec2, by: Vec2): Vec2 => ({ x: v.x * by.x - v.y * by.y, y: v.x * by.y + v.y * by.x });

function sampleCubics(parts: readonly Cubic[], step?: number): Vec2[] {
  return parts.flatMap((c, i) => curve(c.start, c.end, c.incoming, c.outgoing, c.first, c.last, step).slice(i ? 1 : 0));
}

function handleVariants(start: Vec2, end: Vec2, incoming: Vec2, outgoing: Vec2): Cubic[] {
  const chord = distance(start, end);
  return HANDLES.flatMap((first) => HANDLES.map((last) => ({ start, end, incoming, outgoing, first: first * chord, last: last * chord })));
}

function widest(options: readonly (readonly Cubic[])[]): { parts: readonly Cubic[]; radius: number }[] {
  return options.map((parts) => ({ parts, radius: minRadius(sampleCubics(parts, ROUGH_STEP)) }))
    .sort((a, b) => b.radius - a.radius);
}

/** The default cubic first, so existing geometry is unchanged. Only when it bends too tightly, the
 * widest few of longer-handled alternatives (and, through a bend point, other headings there). */
function* curveShapes(start: Vec2, end: Vec2, bend: Vec2 | undefined, incoming: Vec2, outgoing: Vec2): Generator<Vec2[]> {
  const chord = normalize(sub(end, start));
  const preferred = bend
    ? [...curve(start, bend, incoming, chord), ...curve(bend, end, chord, outgoing).slice(1)]
    : curve(start, end, incoming, outgoing);
  yield preferred;
  if (!hasTightBend(preferred)) return;
  const options = bend
    ? BEND_TURNS.map((turn) => {
      const heading = rotate(chord, turn);
      const halves = [handleVariants(start, bend, incoming, heading), handleVariants(bend, end, heading, outgoing)];
      return halves.map((variants) => widest(variants.map((c) => [c]))[0]!.parts[0]!);
    })
    : handleVariants(start, end, incoming, outgoing).map((c) => [c]);
  for (const { parts, radius } of widest(options).slice(0, GENTLE_TRIES)) {
    if (radius >= MIN_RADIUS) yield sampleCubics(parts);
  }
}

type Heading = { heading: Vec2; corner: boolean };

/** Headings the road may take at one end, in the road's direction of travel, preferred first.
 * A free tip can also leave along the drag as a sharp corner node (the network gives it a mouth
 * connector). A steep branch off a street side can also leave square, which keeps wide loops round. */
function endHeadings(snap: StreetPoint | undefined, tipHeading: Vec2, drag: Vec2, smooth: Vec2): Heading[] {
  const fromTip = snap?.kind === 'tip';
  const headings = dot(drag, smooth) >= (fromTip ? 0.45 : Math.SQRT1_2) ? [{ heading: smooth, corner: false }] : [];
  const turn = dot(tipHeading, drag);
  if (fromTip && turn >= MAX_CORNER_TURN && turn < SMOOTH_NODE) headings.push({ heading: drag, corner: true });
  if (snap?.kind === 'street' && Math.abs(dot(snap.tangent, drag)) <= Math.SQRT1_2) {
    const normal = perp(snap.tangent);
    const square = dot(normal, drag) >= 0 ? normal : scale(normal, -1);
    if (dot(square, smooth) < 1 - 1e-9) headings.push({ heading: square, corner: false });
  }
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
  const starts = endHeadings(source, source?.tangent ?? firstChord, firstChord, departing);
  const ends = endHeadings(target, target ? scale(target.tangent, -1) : lastChord, lastChord, arriving);
  const fromTip = source?.kind === 'tip';
  const toTip = target?.kind === 'tip';
  if (!starts.length || !ends.length) {
    const corner = (!starts.length && fromTip) || (!ends.length && toTip);
    yield { reason: fromTip && toTip
      ? 'Leave more room between the road ends for a rounded turn.'
      : corner ? 'That corner is too sharp. Turn by at most 120°.' : 'Extend the road in its direction of travel.' };
  }
  for (const incoming of starts) {
    for (const outgoing of ends) {
      const corners = [incoming.corner, outgoing.corner] as const;
      for (const points of curveShapes(start, end, bend, incoming.heading, outgoing.heading)) yield { points, rounded: false, corners };
    }
  }
}

export function planMeadowRoad(roads: readonly MeadowEdit[], start: Vec2, end: Vec2, bend?: Vec2, roadType: RoadType = 'town'): Plan {
  const fail = (reason: string): Plan => ({ ok: false, reason });
  if (![start, end, ...(bend ? [bend] : [])].every((p) => Number.isFinite(p.x) && Number.isFinite(p.y))) return fail('Choose a point inside the meadow.');
  if (!insideMeadow(start) || !insideMeadow(end) || (bend && !insideMeadow(bend))) return fail('Keep the whole street inside the meadow.');
  const replay = replayMeadow(roads);
  const types = replay.sections.map(s => s.roadType);
  const chains = coalesceStreets(replay.chains, types);
  const source = snapToMeadowStreet(chains, start, 1e-6);
  const target = snapToMeadowStreet(chains, end, 1e-6);
  const onStreet = (p: Vec2) => chains.some((chain) => containsPoint(chain, p));
  if ((!source && onStreet(start)) || (!target && onStreet(end))) return fail('Leave room between junctions and street ends.');
  if ((!target || !source) && distance(start, end) < MIN_LENGTH) return fail('Build at least 12 metres of street.');
  if (bend && (distance(start, bend) < MIN_LENGTH || distance(end, bend) < MIN_LENGTH)) return fail('Give the curve more room.');
  const decor = scenery();
  let rejected: Plan | undefined;
  for (const shape of roadShapes(source, target, start, end, bend, replay.removedArms, decor)) {
    const plan = 'reason' in shape ? fail(shape.reason) : checkRoad(chains, source, target, shape, decor, types, roadType);
    if (plan.ok) {
      const road = { ...plan.road, roadType };
      const paths = roads.filter((edit): edit is WalkEdit => 'walk' in edit && edit.walk === 'footpath');
      if (paths.length) {
        const proposed = meadowNetwork([...roads,road]);
        if (paths.some(path => crossesCarriageway(proposed,path.a,path.b))) {
          rejected ??= fail('Leave the footpath clear of the new street.');
          continue;
        }
      }
      return { ...plan, road };
    }
    rejected ??= plan;
  }
  return rejected!;
}

function checkRoad(
  chains: Vec2[][], source: StreetPoint | undefined, target: StreetPoint | undefined,
  { points, rounded, corners }: Extract<Shape, { points: Vec2[] }>, decor: Decor, types: readonly RoadType[], roadType: RoadType,
): Plan {
  const fail = (reason: string): Plan => ({ ok: false, reason });
  const start = points[0]!;
  const end = tip(points);
  const startsAtNode = (source && source.kind !== 'tip') || corners[0];
  const endsAtNode = (target && target.kind !== 'tip') || corners[1];
  if (startsAtNode && endsAtNode && distance(start, end) < MIN_JUNCTION_SPACING) return fail('Leave room between junctions and street ends.');
  const path = polyline(points);
  if (!rounded && hasTightBend(points)) return fail('That bend is too tight. Try a longer, gentler curve.');
  const half = edgeOffset(roadType, 'left');
  for (const p of points) {
    if (!insideMeadow(p) || p.x - half < BOUNDS.minX || p.x + half > BOUNDS.maxX
      || p.y - half < BOUNDS.minY || p.y + half > BOUNDS.maxY) return { ok: false, points, reason: source?.kind === 'tip' && target?.kind === 'tip'
      ? 'This bend would leave the meadow. Move the road ends farther from the edge.' : 'Keep the whole street inside the meadow.' };
    if (blockedByScenery(p, decor, half - 1)) return fail('Leave room around buildings, water and hills.');
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
  for (const [index, chain] of chains.entries()) {
    const clearance = half + edgeOffset(types[index]!, 'left');
    const attached = joins.filter((join) => containsPoint(chain, join));
    for (const p of points) {
      for (let j = 1; j < chain.length; j++) {
        const closest = projectOntoSegment(p, chain[j - 1]!, chain[j]!);
        const joining = attached.some((join) =>
          distance(closest, join) <= 12 * Math.max(1, clearance / 10) && distance(p, join) <= 16 * Math.max(1, clearance / 10));
        if (!joining && distance(p, closest) < clearance - (attached.length ? 1 : 0)) return fail('Leave space between streets or snap to the street.');
      }
    }
  }
  const lengths = path.cum;
  for (let i = 0; i < points.length; i++) {
    for (let j = i + 2; j < points.length; j++) {
      if (lengths[j]! - lengths[i]! > 24 && distance(points[i]!, points[j]!) < 2 * half) return fail('Leave space between streets.');
    }
  }
  const fourWays = [...crossings];
  for (const snap of [source, target]) {
    if (snap?.kind === 'junction') fourWays.push({ point: snap.point, priorityAxis: snap.priorityAxis });
  }
  return { ok: true, road: fourWays.length ? { points, fourWays } : { points }, path };
}
