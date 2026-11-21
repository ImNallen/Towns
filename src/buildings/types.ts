import type { PALETTE } from '../render/palette';

/** Metres in the lot frame: x along the frontage, y away from the front kerb; origin at lot centre. */
export interface Footprint { x: number; y: number; width: number; depth: number }
export type Tier = 'cheap' | 'mid' | 'expensive';
export interface LotSize { columns: number; rows: number }
export type Roof = { kind: 'gable' | 'hip'; rise: number; ridge: 'x' | 'y' } | { kind: 'flat' }
  | { kind: 'sawtooth'; bays: number; rise: number };
export type Part =
  | (Footprint & { kind: 'block' | 'wing' | 'garage'; height: number; roof: Roof })
  | (Footprint & { kind: 'awning' | 'porch' | 'chimney' | 'hedge' | 'fence'; height: number })
  | (Footprint & { kind: 'slab'; base: number; height: number; finish: keyof typeof PALETTE.building.industrial })
  | { kind: 'flue' | 'condenser'; x: number; y: number; base: number; radius: number }
  | (Footprint & { kind: 'pool' })
  | { kind: 'tree'; x: number; y: number; radius: number; height: number };
export type WallSwatch = keyof typeof PALETTE.building.walls;
export type RoofSwatch = keyof typeof PALETTE.building.roofs;
export interface Blueprint {
  id: string;
  name: string;
  zone: import('../sim/zoning/paint').ZoneKind;
  tier: Tier;
  density: 'low';
  lot: LotSize;
  roofs: readonly [RoofSwatch, RoofSwatch, RoofSwatch, ...RoofSwatch[]];
  walls: readonly [WallSwatch, ...WallSwatch[]];
  parts: readonly Part[];
  upgradesTo?: string;
}
export interface Variant { wall: WallSwatch; roof: RoofSwatch; mirrored: boolean }
export interface BuildingPick { blueprint: Blueprint; variant: Variant }
