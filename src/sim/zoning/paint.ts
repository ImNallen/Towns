import { decodeCellKey, findCell, ZONE_ROWS, type CellKey, type ZoneCells } from './cells';

export const ZONE_KINDS = ['residential', 'shops', 'workplaces'] as const;
export type ZoneKind = (typeof ZONE_KINDS)[number];

/**
 * One brush stroke in the Meadow edit list: one undo step and one RoadIndex slot. `zone: null` erases.
 * As made by `planZoneStroke`, `cells` is non-empty and ascending, every key was live when the stroke was
 * made, and every key's zone changed, so undoing a stroke always changes what the player sees.
 */
export type LandUse = ZoneKind | 'parking';

export interface ZoneStroke {
  readonly zone: LandUse | null;
  readonly cells: readonly CellKey[];
}

export type Zoning = ReadonlyMap<CellKey, LandUse>;

export type StrokePlan = { ok: true; stroke: ZoneStroke } | { ok: false; reason: string };

export function planZoneStroke(
  cells: ZoneCells, zoning: Zoning, zone: LandUse | null, touched: readonly CellKey[],
): StrokePlan {
  const footprint = new Set<CellKey>();
  for (const key of touched) {
    if (findCell(cells, key) < 0) {
      if (zone === 'parking') return { ok: false, reason: 'The whole lot needs open street frontage.' };
      continue;
    }
    const { row } = decodeCellKey(key);
    if (zone === 'parking') {
      if (row !== 0 || zoning.has(key) || cells.gardenCells?.[findCell(cells, key)]) return { ok: false, reason: 'Choose empty frontage beside the street.' };
      footprint.add(key);
      continue;
    }
    const front = key - row;
    const [from, to] = zone === null ? [row, ZONE_ROWS - 1] : [0, row];
    for (let r = from; r <= to; r++) {
      const k = (front + r) as CellKey;
      if (findCell(cells, k) >= 0) footprint.add(k);
    }
  }
  if (zone && zone !== 'parking' && [...footprint].some(k => zoning.get(k) === 'parking')) {
    return { ok: false, reason: 'Clear the parking lot first.' };
  }
  if (footprint.size === 0) return { ok: false, reason: 'Drag across the plots beside a street.' };
  const changed = [...footprint].filter((k) => (zoning.get(k) ?? null) !== zone).sort((a, b) => a - b);
  if (changed.length === 0) return { ok: false, reason: zone === null ? 'Nothing to erase here.' : `Already zoned ${zone}.` };
  return { ok: true, stroke: { zone, cells: changed } };
}
