import { BLUEPRINTS } from '../../buildings/catalogue';
import { finishBuilding, pickBuilding } from '../../buildings/variation';
import type { BuildingPick, LotSize } from '../../buildings/types';
import { add, normalize, scale, sub, type Vec2 } from '../math/vec';
import { accessPoints } from '../scenarios/meadow';
import type { Scenario } from '../scenarios/types';
import { decodeCellKey, ZONE_KERB, type CellKey, type ZoneCells } from './cells';
import type { Zoning } from './paint';

export interface Lot extends LotSize {
  key: CellKey;
  x: number;
  y: number;
  angle: number;
  streetX: number;
  streetY: number;
  corners: Vec2[];
  designs: BuildingPick[];
}

export function sameParcel(old: Lot, current: Lot | undefined): boolean {
  return current?.key === old.key && current.rows === old.rows && current.columns === old.columns
    && current.designs[0]!.blueprint.zone === old.designs[0]!.blueprint.zone;
}

const COTTAGE = { columns: 1, rows: 1 } as const;
const DETACHED = { columns: 2, rows: 2 } as const;

function footprint(key: CellKey, size: LotSize): CellKey[] {
  const keys: CellKey[] = [];
  for (let c = 0; c < size.columns; c++) {
    for (let r = 0; r < size.rows; r++) keys.push((key + c * 8 + r) as CellKey);
  }
  return keys;
}

/** Walk the kerb left-to-right, then the rear boundary in reverse. */
function parcelGeometry(cells: ZoneCells, indices: Map<CellKey, number>, key: CellKey, size: LotSize) {
  const { side } = decodeCellKey(key);
  const point = (column: number, row: number, corner: number): Vec2 => {
    const cell = indices.get((key + column * 8 + row) as CellKey)!;
    const offset = cell * 8 + corner * 2;
    return { x: cells.corners[offset]!, y: cells.corners[offset + 1]! };
  };
  const columns = Array.from({ length: size.columns }, (_, i) => side === 0 ? i : size.columns - 1 - i);
  const front = columns.map(c => point(c, 0, 0));
  front.push(point(columns.at(-1)!, 0, 1));
  const rear = columns.map(c => point(c, size.rows - 1, 3));
  rear.push(point(columns.at(-1)!, size.rows - 1, 2));
  // Take the middle of each boundary, including the middle vertex on a bent frontage.
  const mid = (edge: Vec2[]) => scale(add(edge[Math.floor(size.columns / 2)]!, edge[Math.ceil(size.columns / 2)]!), 0.5);
  const kerb = mid(front);
  const back = mid(rear);
  const towardStreet = normalize(sub(kerb, back));
  const middle = scale(add(kerb, back), 0.5);
  // The larger designs have enough garden in front to move one metre closer to the kerb.
  const centre = size.rows === 2 ? add(middle, towardStreet) : middle;
  const street = add(kerb, scale(towardStreet, cells.kerbs?.[indices.get(key)!] ?? ZONE_KERB));
  const tangent = sub(front.at(-1)!, front[0]!);
  return { ...centre, angle: Math.atan2(tangent.y, tangent.x), streetX: street.x, streetY: street.y,
    corners: [...front, ...rear.reverse()] };
}

/** Slot order and finishes survive subsequent changes to the surrounding parcels. */
export interface ParcelSlot {
  key: CellKey;
  designs: [blueprint: string, wall: number, roof: number, mirrored: boolean][];
}

export function saveParcel(lot: Lot): ParcelSlot {
  return { key: lot.key, designs: lot.designs.map(({ blueprint, variant }) =>
    [blueprint.id, blueprint.walls.indexOf(variant.wall), blueprint.roofs.indexOf(variant.roof), variant.mirrored]) };
}

export function restoreParcels(cells: ZoneCells, slots: (ParcelSlot | null)[], zoning: Zoning): (Lot | null)[] {
  const indices = new Map<CellKey, number>();
  for (let i = 0; i < cells.count; i++) indices.set(cells.keys[i]! as CellKey, i);
  const reserved = new Set<CellKey>();
  return slots.map(slot => {
    if (!slot) return null;
    const designs = slot.designs.map(([id, wall, roof, mirrored]) => {
      const blueprint = BLUEPRINTS.find(b => b.id === id);
      if (!blueprint || !blueprint.walls[wall] || !blueprint.roofs[roof] || blueprint.zone !== zoning.get(slot.key))
        throw new Error('Unknown snapshot building design.');
      return { blueprint, variant: { wall: blueprint.walls[wall]!, roof: blueprint.roofs[roof]!, mirrored } };
    });
    const size = designs[0]!.blueprint.lot;
    const zone = zoning.get(slot.key);
    if (designs.length !== (zone === 'residential' ? 3 : 1)) throw new Error('Incomplete snapshot building design.');
    for (const key of footprint(slot.key, size)) {
      if (!indices.has(key) || reserved.has(key) || zoning.get(key) !== zone) throw new Error('Invalid snapshot parcel.');
      reserved.add(key);
    }
    return { key: slot.key, ...size, designs, ...parcelGeometry(cells, indices, slot.key, size) };
  });
}

/** Keep occupied parcels while all their cells survive. Each four columns allow one
 * detached house and two cottages. Stagger the wider lots on opposite sides of the street. */
export function zonedLots(scenario: Scenario, zoning: Zoning, occupied: Lot[] = []): Lot[] {
  const cells = scenario.zones;
  if (!cells) return [];
  const available = new Map<CellKey, number>();
  const gardens = scenario.decor.houses.flatMap(h => h.garden ?? []);
  for (let i = 0; i < cells.count; i++) {
    const key = cells.keys[i]! as CellKey;
    if (!zoning.has(key) || (zoning.get(key) === 'parking' || zoning.get(key) === 'park')) continue;
    const q = cells.corners.subarray(i * 8, i * 8 + 8);
    const xs = [q[0]!, q[2]!, q[4]!, q[6]!], ys = [q[1]!, q[3]!, q[5]!, q[7]!];
    if (gardens.some(g => Math.min(...xs) < g.maxX && Math.max(...xs) > g.minX
      && Math.min(...ys) < g.maxY && Math.max(...ys) > g.minY)) continue;
    available.set(key, i);
  }
  const lots: Lot[] = [];
  const reserve = (lot: Lot) => {
    lots.push(lot);
    for (const k of footprint(lot.key, lot)) available.delete(k);
  };
  for (const lot of occupied) {
    if (footprint(lot.key, lot).every(k => available.has(k) && zoning.get(k) === lot.designs[0]!.blueprint.zone)) {
      reserve({ ...lot, ...parcelGeometry(cells, available, lot.key, lot) });
    }
  }
  for (const key of available.keys()) {
    const { road, column, row, side } = decodeCellKey(key);
    if (row !== 0) continue;
    const zone = zoning.get(key)!;
    if (zone === 'parking' || zone === 'park') continue;
    const detached = (zone === 'workplaces' || (column + side * 2) % 4 === 0)
      && footprint(key, DETACHED).every(k => available.has(k) && zoning.get(k) === zone);
    const size = detached ? DETACHED : COTTAGE;
    const geometry = parcelGeometry(cells, available, key, size);
    if (!accessPoints(scenario.network, { x: geometry.streetX, y: geometry.streetY }).length) continue;
    const neighbours = lots.filter(l => {
      const other = decodeCellKey(l.key);
      return other.road === road && other.side === side
        && (other.column + l.columns === column || column + size.columns === other.column);
    }).map(l => l.designs[0]!);
    const designs = [pickBuilding(String(key), 'cheap', size, neighbours, zone)];
    if (zone === 'residential') {
      for (const tier of ['mid', 'expensive'] as const) {
        const next = BLUEPRINTS.find(b => b.id === designs.at(-1)!.blueprint.upgradesTo
          && b.lot.columns === size.columns && b.lot.rows === size.rows);
        designs.push(next ? finishBuilding(String(key), next) : pickBuilding(String(key), tier, size));
      }
    }
    reserve({ ...size, ...geometry, key, designs });
  }
  return lots.sort((a, b) => a.key - b.key);
}
