import { BLUEPRINTS } from './catalogue';
import type { Blueprint, BuildingPick, LotSize, Tier, Variant } from './types';

function hash(key: string): number {
  let value = 2166136261;
  for (let i = 0; i < key.length; i++) value = Math.imul(value ^ key.charCodeAt(i), 16777619);
  return value >>> 0;
}
/** Mix high and low bits before indexing small palettes, including power-of-two lengths. */
function finishHash(key: string, channel: string): number {
  const value = hash(`${key}:${channel}`);
  const mixed = Math.imul(value ^ (value >>> 16), 0x85ebca6b);
  return (mixed ^ (mixed >>> 13)) >>> 0;
}

/** Sweep through the walls, shifting the roof by one on each subsequent pass. */
export function catalogueVariants({ walls, roofs }: Blueprint): Variant[] {
  return Array.from({ length: Math.min(6, walls.length * roofs.length) }, (_, i) => {
    const column = i % walls.length;
    return {
      wall: walls[column]!,
      roof: roofs[(column + Math.floor(i / walls.length)) % roofs.length]!,
      mirrored: i % 2 === 1,
    };
  });
}
/** Call in stable lot-key order, passing already assigned adjacent picks (at most two).
 * Sizes are positive whole cells, rows <= 4. Prefer the largest fitting design; fall back
 * to smaller footprints when neighbours exhaust that size. Never resize authored geometry.
 */
export function pickBuilding(key: string, tier: Tier, lot: LotSize, neighbours: readonly BuildingPick[] = []): BuildingPick {
  if (!Number.isInteger(lot.columns) || !Number.isInteger(lot.rows) || lot.columns < 1 || lot.rows < 1 || lot.rows > 4) throw new Error('Invalid residential lot size');
  if (neighbours.length > 2) throw new Error('A street lot supports at most two assigned neighbours');
  const eligible = BLUEPRINTS.filter((b) => b.tier === tier && b.lot.columns <= lot.columns && b.lot.rows <= lot.rows && !neighbours.some(n => n.blueprint.id === b.id));
  const area = Math.max(...eligible.map((b) => b.lot.columns * b.lot.rows));
  const fitting = eligible.filter((b) => b.lot.columns * b.lot.rows === area);
  const blueprint = fitting[hash(key) % fitting.length];
  if (!blueprint) throw new Error('No compatible blueprint');
  const wall = blueprint.walls[finishHash(key, 'wall') % blueprint.walls.length]!;
  const roofs = blueprint.roofs.filter(roof => !neighbours.some(n => n.variant.wall === wall && n.variant.roof === roof));
  // Each design allows at least three roofs, so two neighbours always leave a choice.
  const roof = roofs[finishHash(key, 'roof') % roofs.length]!;
  return { blueprint, variant: { wall, roof, mirrored: (finishHash(key, 'mirror') & 1) === 1 } };
}
