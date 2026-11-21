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
  paving: FlatMesh;
  gravel: FlatMesh;
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

type CellPoint = (x: number, y: number) => Vec2;

/** Coordinates are fractions of this cell so a pad follows the curve of its plot. */
function businessYard(point: CellPoint, details: YardDetails, blueprint: Blueprint, rowBehind: number, column: number) {
  const rect = (mesh: FlatMesh, x: number, y: number, w: number, h: number) =>
    mesh.quad(point(x, y), point(x + w, y), point(x + w, y + h), point(x, y + h));
  const shop = blueprint.zone === 'shops';
  if (rowBehind === 0) {
    // Half the job capacity: one space per shop column, two per workplace column.
    const bays = shop ? 1 : 2;
    rect(details.paving, 0.08, 0, bays * 0.30 + 0.09, 0.73);
    for (let i = 0; i <= bays; i++) rect(details.marking, 0.12 + i * 0.30, 0.16, 0.018, 0.52);
    rect(details.marking, 0.12, 0.66, bays * 0.30, 0.02);
    if (shop) {
      // A gravel path links the shop door to its patio or garden.
      rect(details.gravel, 0.60, 0, 0.18, 1);
    } else if (column % 2 === 0) {
      rect(details.gravel, 0.68, 0, 0.20, 1);
    }
  } else if (rowBehind === 1) {
    if (shop) {
      const cafe = blueprint.id === 'lime-cafe' || blueprint.id === 'bread-shop';
      if (cafe) {
        rect(details.gravel, 0.21, 0, 0.62, 0.69);
        // A timber picnic table with two separate benches.
        rect(details.timber, 0.34, 0.23, 0.35, 0.15);
        for (const y of [0.11, 0.44]) rect(details.timber, 0.34, y, 0.35, 0.065);
      } else {
        for (const x of [0.20, 0.46]) {
          rect(details.gravel, x, 0.13, 0.19, 0.53);
          rect(details.hedge, x + 0.03, 0.17, 0.13, 0.45);
        }
      }
    } else if (column % 2 === 0) {
      rect(details.gravel, 0.21, 0, 0.67, 0.68);
      if (blueprint.id === 'survey-office' || blueprint.id === 'studios') {
        const p = point(0.53, 0.36);
        const q = point(0.67, 0.36);
        details.sheds.push({ ...p, angle: Math.atan2(q.y - p.y, q.x - p.x) });
      } else {
        for (const x of [0.31, 0.60]) {
          rect(details.timber, x, 0.15, 0.18, 0.41);
          for (const y of [0.23, 0.45]) rect(details.straps, x, y, 0.18, 0.03);
        }
      }
    }
  }
}

/** Follow each column independently, stopping at a gap, different paint or starter garden. */
export function extendYard(lot: Lot, blueprint: Blueprint, land: PaintedLand, houses: readonly House[],
  details: YardDetails): Vec2[] {
  const { ground, hedge, trees, sheds } = details;
  const { road, side, column } = decodeCellKey(lot.key);
  const rear: Vec2[] = [];
  for (let i = 0; i < lot.columns; i++) {
    const col = column + (side === 0 ? i : lot.columns - 1 - i);
    let left = lot.corners.at(-1 - i)!;
    let right = lot.corners.at(-2 - i)!;
    let lastCell: CellPoint | undefined;
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

      const point = (x: number, y: number) => lerp(lerp(a!, b!, x), lerp(d!, c!, x), y);
      lastCell = point;
      if (blueprint.zone === 'residential') {
        if (i === 0 && row === lot.rows && col % 4 === 0) sheds.push({ ...point(0.55, 0.7), angle: lot.angle });
        else if ((col + row) % 3 === 0) trees.push(point(0.52, 0.6));
        if (i === 0) hedge.quad(point(0.03, 0), point(0.11, 0), point(0.11, 1), point(0.03, 1));
        if (i === lot.columns - 1) hedge.quad(point(0.89, 0), point(0.97, 0), point(0.97, 1), point(0.89, 1));
      } else {
        businessYard(point, details, blueprint, row - lot.rows, col);
        if (i === 0) hedge.quad(point(0.025, 0), point(0.075, 0), point(0.075, 1), point(0.025, 1));
      }
    }
    if (lastCell) {
      const near = (p: Vec2) => lerp(p, {x: lot.x, y: lot.y}, 0.035);
      hedge.quad(left, right, near(right), near(left));
      if (blueprint.zone !== 'residential') {
        const x = col % 2 === 0 ? 0.30 : 0.72;
        trees.push(lastCell(x, 0.83));
      }
    }
    const prev = rear.at(-1);
    if (!prev || prev.x !== left.x || prev.y !== left.y) rear.push(left);
    rear.push(right);
  }
  return [...lot.corners.slice(0, lot.columns + 1), ...rear.reverse()];
}
