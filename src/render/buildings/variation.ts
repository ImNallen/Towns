import { BLUEPRINTS } from './catalogue';
import type { Blueprint, BuildingPick, LotSize, Tier, Variant, RoofSwatch } from './types';

function hash(key: string): number {
  let value = 2166136261;
  for (let i = 0; i < key.length; i++) value = Math.imul(value ^ key.charCodeAt(i), 16777619);
  return value >>> 0;
}
export function variants(blueprint: Blueprint): Variant[] {
  const roofs: readonly RoofSwatch[] = ['slate', 'terracotta', 'sage'];
  return blueprint.swatches.flatMap((wall, i) => [false, true].map((mirrored) => ({ wall, roof: roofs[i % roofs.length]!, mirrored })));
}
/** Call in stable lot-key order, passing already assigned adjacent designs (at most two).
 * Sizes are positive whole cells, rows <= 4. Prefer the largest fitting design; fall back
 * to smaller footprints when neighbours exhaust that size. Never resize authored geometry.
 */
export function pickBuilding(key: string, tier: Tier, lot: LotSize, neighbours: readonly string[] = []): BuildingPick {
  if (!Number.isInteger(lot.columns) || !Number.isInteger(lot.rows) || lot.columns < 1 || lot.rows < 1 || lot.rows > 4) throw new Error('Invalid residential lot size');
  if (new Set(neighbours).size > 2) throw new Error('A street lot supports at most two assigned neighbours');
  const eligible = BLUEPRINTS.filter((b) => b.tier === tier && b.lot.columns <= lot.columns && b.lot.rows <= lot.rows && !neighbours.includes(b.id));
  const area = Math.max(...eligible.map((b) => b.lot.columns * b.lot.rows));
  const fitting = eligible.filter((b) => b.lot.columns * b.lot.rows === area);
  const blueprint = fitting[hash(key) % fitting.length];
  if (!blueprint) throw new Error('No compatible blueprint');
  const choices = variants(blueprint);
  return { blueprint, variant: choices[hash(`${key}:finish`) % choices.length]! };
}
