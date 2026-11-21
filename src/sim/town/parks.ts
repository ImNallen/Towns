import type { Vec2 } from '../math/vec';
import { decodeCellKey, findCell, type CellKey, type ZoneCells } from '../zoning/cells';
import type { Zoning } from '../zoning/paint';

export const PARK_RADIUS = 450;
export interface Park extends Vec2 {
  key: CellKey;
  cells: CellKey[];
  name: string;
}
/** Contiguous frontage gardens share one entrance and one destination. */
export function parksOn(cells: ZoneCells | undefined, zoning: Zoning): Park[] {
  if (!cells) return [];
  const remaining = new Set(
    [...zoning]
      .filter(([key, use]) => use === 'park' && findCell(cells, key) >= 0)
      .map(([k]) => k)
      .sort((a, b) => a - b),
  );
  const parks: Park[] = [];
  for (const key of remaining) {
    remaining.delete(key);
    const members = [key];
    let x = 0,
      y = 0;
    for (let i = 0; i < members.length; i++) {
      const k = members[i]!,
        { row } = decodeCellKey(k),
        slot = findCell(cells, k);
      for (let corner = 0; corner < 4; corner++) {
        x += cells.corners[slot * 8 + 2 * corner]! / 4;
        y += cells.corners[slot * 8 + 2 * corner + 1]! / 4;
      }
      for (const offset of [-8, 8, ...(row > 0 ? [-1] : []), ...(row < 3 ? [1] : [])]) {
        const neighbour = (k + offset) as CellKey;
        if (remaining.delete(neighbour)) members.push(neighbour);
      }
    }
    parks.push({
      key,
      cells: members,
      name: 'Meadow Park ' + (parks.length + 1),
      x: x / members.length,
      y: y / members.length,
    });
  }
  return parks;
}

export function parkFootprint(start: CellKey, size: number): CellKey[] {
  const front = start - decodeCellKey(start).row;
  const result: CellKey[] = [];
  for (let col = 0; col < size; col++)
    for (let row = 0; row < size; row++) result.push((front + col * 8 + row) as CellKey);
  return result;
}
