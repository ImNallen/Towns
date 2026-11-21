import { decodeCellKey, findCell, ZONE_ROWS, type CellKey, type ZoneCells } from './cells';

/** Every zone a player can paint, in display order. The palette and the brush picker are derived from it. */
export const ZONE_KINDS = ['residential'] as const;
export type ZoneKind = (typeof ZONE_KINDS)[number];

/**
 * One brush stroke in the Meadow edit list: one undo step and one RoadIndex slot. `zone: null` erases.
 * As made by `planZoneStroke`, `cells` is non-empty and ascending, every key was live when the stroke was
 * made, and every key's zone changed, so undoing a stroke always changes what the player sees.
 */
export interface ZoneStroke {
  readonly zone: ZoneKind | null;
  readonly cells: readonly CellKey[];
}

/** Zone of every live painted cell, in ascending key order. Derived by `meadowZoning`, never stored. */
export type Zoning = ReadonlyMap<CellKey, ZoneKind>;

export type StrokePlan = { ok: true; stroke: ZoneStroke } | { ok: false; reason: string };

/**
 * The stroke a drag over `touched` makes against the current cells and zoning; the editor previews with it
 * and the worker accepts with it. Painting a cell also paints the rows between it and the street, so one
 * drag along the back row zones a block. Erasing a cell also clears the rows behind it. Keys that are not
 * live cells are ignored, and only keys whose zone changes are kept.
 */
export function planZoneStroke(
  cells: ZoneCells, zoning: Zoning, zone: ZoneKind | null, touched: readonly CellKey[],
): StrokePlan {
  const footprint = new Set<CellKey>();
  for (const key of touched) {
    if (findCell(cells, key) < 0) continue;
    const { row } = decodeCellKey(key);
    const front = key - row;
    const [from, to] = zone === null ? [row, ZONE_ROWS - 1] : [0, row];
    for (let r = from; r <= to; r++) {
      const k = (front + r) as CellKey;
      if (findCell(cells, k) >= 0) footprint.add(k);
    }
  }
  if (footprint.size === 0) return { ok: false, reason: 'Drag across the plots beside a street.' };
  const changed = [...footprint].filter((k) => (zoning.get(k) ?? null) !== zone).sort((a, b) => a - b);
  if (changed.length === 0) return { ok: false, reason: zone === null ? 'Nothing to erase here.' : `Already zoned ${zone}.` };
  return { ok: true, stroke: { zone, cells: changed } };
}
