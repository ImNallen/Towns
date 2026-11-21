import type { HouseholdView } from '../sim/town/town';
import type { House } from '../sim/scenarios/types';
import type { Vec2 } from '../sim/math/vec';
import { cellKey, decodeCellKey, findCell, ZONE_ROWS, type ZoneCells } from '../sim/zoning/cells';
import type { Zoning } from '../sim/zoning/paint';
import type { Blueprint } from '../buildings/types';
import { FlatMesh } from './flat';
import { cellQuad } from './zones';

type Lot = NonNullable<HouseholdView['lot']>;
export interface YardDetails {
  ground: FlatMesh;
  hedge: FlatMesh;
  marking: FlatMesh;
  timber: FlatMesh;
  straps: FlatMesh;
  trees: Vec2[];
  sheds: Array<Vec2 & { angle: number }>;
}

export interface PaintedLand {
  cells: ZoneCells;
  zoning: Zoning;
}

const lerp = (a: Vec2, b: Vec2, t: number) => ({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t });

/** Follow each column independently, stopping at a gap, different paint or starter garden. */
export function extendYard(lot: Lot, blueprint: Blueprint, land: PaintedLand, houses: readonly House[],
  { ground, hedge, marking, timber, straps, trees, sheds }: YardDetails): Vec2[] {
  const { road, side, column } = decodeCellKey(lot.key);
  const rear: Vec2[] = [];
  for (let i = 0; i < lot.columns; i++) {
    const col = column + (side === 0 ? i : lot.columns - 1 - i);
    let left = lot.corners.at(-1 - i)!;
    let right = lot.corners.at(-2 - i)!;
    let extended = false;
    for (let row = lot.rows; row < ZONE_ROWS; row++) {
      const key = cellKey(road, col, side, row);
      if (land.zoning.get(key) !== blueprint.zone) break;
      const quad = cellQuad(land.cells, findCell(land.cells, key));
      if (houses.some(({garden: g}) => g && quad.some(p => p.x > g.minX) && quad.some(p => p.x < g.maxX)
        && quad.some(p => p.y > g.minY) && quad.some(p => p.y < g.maxY))) break;
      const [a, b, c, d] = quad;
      ground.quad(a!, b!, c!, d!);
      left = d!;
      right = c!;
      extended = true;
      const point = (x: number, y: number) => lerp(lerp(a!, b!, x), lerp(d!, c!, x), y);
      if (blueprint.zone === 'residential') {
        if (i === 0 && row === lot.rows && col % 4 === 0) sheds.push({ ...point(0.55, 0.7), angle: lot.angle });
        else if ((col + row) % 3 === 0) trees.push(point(0.52, 0.6));
        if (i === 0) hedge.quad(point(0.03, 0), point(0.11, 0), point(0.11, 1), point(0.03, 1));
        if (i === lot.columns - 1) hedge.quad(point(0.89, 0), point(0.97, 0), point(0.97, 1), point(0.89, 1));
      } else if (blueprint.zone === 'workplaces' && row === ZONE_ROWS - 1 && col % 3 !== 0) {
        for (const x of [0.16, 0.52]) {
          timber.quad(point(x, 0.24), point(x + 0.26, 0.24), point(x + 0.26, 0.8), point(x, 0.8));
          for (const y of [0.34, 0.68]) {
            straps.quad(point(x, y), point(x + 0.26, y), point(x + 0.26, y + 0.035), point(x, y + 0.035));
          }
        }
      } else if (row % 2 === 1) {
        // Leave a circulation aisle between rows of parking.
        // Two parking bays sharing a rear stop line.
        for (const x of [0.13, 0.5, 0.87]) marking.quad(point(x, 0.3), point(x + 0.025, 0.3), point(x + 0.025, 0.87), point(x, 0.87));
        marking.quad(point(0.13, 0.85), point(0.895, 0.85), point(0.895, 0.87), point(0.13, 0.87));
      }
    }
    if (extended && blueprint.zone === 'residential') {
      const near = (p: Vec2) => lerp(p, {x: lot.x, y: lot.y}, 0.035);
      hedge.quad(left, right, near(right), near(left));
    }
    const prev = rear.at(-1);
    if (!prev || prev.x !== left.x || prev.y !== left.y) rear.push(left);
    rear.push(right);
  }
  return [...lot.corners.slice(0, lot.columns + 1), ...rear.reverse()];
}
