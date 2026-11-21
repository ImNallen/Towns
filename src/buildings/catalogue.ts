import type { Blueprint, Part, Roof, Tier } from './types';

const gable = (ridge: 'x' | 'y' = 'x'): Roof => ({ kind: 'gable', rise: 1.8, ridge });
const hip = (ridge: 'x' | 'y' = 'x'): Roof => ({ kind: 'hip', rise: 2, ridge });
const flat: Roof = { kind: 'flat' };
const block = (x: number, y: number, width: number, depth: number, roof: Roof, height = 3): Part => ({ kind: 'block', x, y, width, depth, roof, height });
const wing = (x: number, y: number, width: number, depth: number, roof: Roof): Part => ({ kind: 'wing', x, y, width, depth, roof, height: 2.8 });
const garage = (x: number, y: number, width = 3.4, depth = 5): Part => ({ kind: 'garage', x, y, width, depth, height: 2.5, roof: flat });
const porch = (x: number, y: number, width = 3, depth = 1.5): Part => ({ kind: 'porch', x, y, width, depth, height: 0.3 });
const tree = (x: number, y: number, radius = 1.3): Part => ({ kind: 'tree', x, y, radius, height: 3.5 });
const hedge = (x: number, y: number, width: number, depth: number): Part => ({ kind: 'hedge', x, y, width, depth, height: 1.1 });
const pool = (x: number, y: number, width = 3, depth = 5): Part => ({ kind: 'pool', x, y, width, depth });
const awning = (x: number, y: number, width: number, depth = 1.3): Part => ({ kind: 'awning', x, y, width, depth, height: 2.5 });
const chimney = (x: number, y: number): Part => ({ kind: 'chimney', x, y, width: 0.7, depth: 0.7, height: 5.3 });
type Swatches = Pick<Blueprint, 'walls' | 'roofs'>;
const finishes = {
  cheap: { walls: ['stone', 'cream', 'mist', 'chalk'], roofs: ['slate', 'moss', 'tan'] },
  mid: { walls: ['cream', 'brick', 'ochre', 'celadon', 'rose'], roofs: ['terracotta', 'slate', 'tan', 'charcoal'] },
  expensive: { walls: ['chalk', 'stone', 'rose', 'celadon', 'brick'], roofs: ['charcoal', 'moss', 'slate', 'terracotta'] },
} as const satisfies Record<Tier, Swatches>;

const modern: Swatches = { walls: ['chalk', 'mist', 'stone', 'celadon'], roofs: ['charcoal', 'tan', 'slate'] };

function design(id: string, name: string, tier: Tier, columns: number, rows: number, parts: Part[],
  upgradesTo?: string, swatches: Swatches = finishes[tier]): Blueprint {
  return { id, name, zone: 'residential', tier, density: 'low', lot: { columns, rows }, ...swatches, parts, ...(upgradesTo ? { upgradesTo } : {}) };
}

function business(id: string, name: string, zone: 'shops' | 'workplaces', size: number, parts: Part[]): Blueprint {
  return { ...design(id, name, 'cheap', size, size, parts), zone, ...(zone === 'shops' ? finishes.mid : modern) };
}

/** Authored footprints, not random combinations. Compact designs keep every 1–4 cell lot usable. */
export const BLUEPRINTS: readonly Blueprint[] = [
  design('acorn', 'Acorn cottage', 'cheap', 1, 1, [block(0, 0.4, 4.7, 4, gable()), porch(0, -2.3), tree(2.6, 2.6, 0.7)], 'mews'),
  design('reed', 'Reed bungalow', 'cheap', 1, 1, [block(-0.6, 0, 3.5, 5.4, gable('y')), porch(2, -1, 1.3, 3), chimney(-0.7, 1.4)], 'atelier'),
  design('fern', 'Fern cabin', 'cheap', 1, 1, [block(-0.7, 0.9, 4, 3.5, flat), wing(1.7, -0.6, 1.8, 3, flat), tree(-2.7, -2.5, 0.7)], 'court', modern),
  design('wren', 'Wren lodge', 'cheap', 2, 2, [block(-2, 0, 7, 5, gable()), wing(2, 2, 4, 5, gable('y')), porch(-2, -3.2), tree(5, 5)], 'elm'),
  design('birch', 'Birch bungalow', 'cheap', 2, 2, [block(0, 1, 9, 5, hip()), porch(0, -2.5, 6), tree(-5, -4), tree(5, 5)], 'cedar'),
  design('ash', 'Ash cottage', 'cheap', 2, 2, [block(-2, 1, 5, 8, gable('y')), garage(3, -1), chimney(-2, 3), tree(4, 5)], 'elm'),
  design('clover', 'Clover cottage', 'cheap', 2, 2, [block(0, 1, 7, 6, gable()), porch(0, -3, 7, 2), tree(5, 4), hedge(-6, 0, 0.7, 10)], 'cedar'),
  design('finch', 'Finch twin gable', 'cheap', 2, 2, [block(-2, 0, 4, 7, gable('y')), block(2, 1, 4, 5, gable('y')), tree(5, -4)], 'rowan'),
  design('moss', 'Moss studio', 'cheap', 2, 2, [block(-1, 1, 8, 5, flat), wing(3, -2, 3, 4, flat), porch(-2, -2.5, 4), tree(-5, 5)], 'hazel', modern),
  design('lark', 'Lark homestead', 'cheap', 2, 3, [block(0, -3, 8, 6, gable()), garage(-4, 4), tree(4, 7), tree(-4, 8), { kind: 'fence', x: 0, y: 10, width: 13, depth: 0.2, height: 1 }], 'willow'),
  design('mews', 'Mews house', 'mid', 1, 1, [block(-0.5, 0.5, 4.2, 4.5, hip(), 4.5), garage(2.2, -0.7, 1.6, 3.5), porch(-1, -2.5)], 'jewel'),
  design('atelier', 'Garden atelier', 'mid', 1, 1, [block(-0.8, 0, 3.5, 5.5, gable('y'), 4.5), wing(1.8, 1, 1.8, 3, flat), tree(2.5, -2.5, 0.7)], 'pavilion'),
  design('court', 'Little courtyard', 'mid', 1, 1, [block(0, 1.5, 5.6, 2.5, flat, 4), wing(-1.8, -0.8, 2, 3.3, flat), garage(1.8, -0.8, 2, 3.3), porch(0, -1.5, 1.5)], 'terrace'),
  design('elm', 'Elm detached', 'mid', 2, 2, [block(-1.5, 1, 7, 8, gable('y'), 5), garage(4, -1), porch(-1, -4), tree(5, 5)], 'laurel'),
  design('cedar', 'Cedar house', 'mid', 2, 2, [block(0, 1, 9, 6, hip(), 4), wing(-3, -3, 3, 4, hip('y')), garage(5, 1, 3, 5), tree(-5, 5)], 'laurel'),
  design('rowan', 'Rowan cross gable', 'mid', 2, 2, [block(0, 1, 10, 5, gable(), 4), wing(0, -2, 4, 6, gable('y')), garage(-4, -3, 3, 4), tree(5, 5)], 'olive'),
  design('hazel', 'Hazel modern', 'mid', 2, 2, [block(-2, 1, 6, 8, flat, 5), wing(3, 3, 5, 4, flat), garage(3, -2), porch(-2, -4, 6), tree(5, 6)], 'olive', modern),
  design('willow', 'Willow garden house', 'mid', 2, 3, [block(-1, -3, 8, 7, hip(), 4.5), wing(3, 2, 4, 6, gable('y')), garage(-4, 3), tree(-4, 8), tree(4, 8)]),
  design('jewel', 'Jewel villa', 'expensive', 1, 1, [block(0, 0.7, 5.3, 4, hip(), 5.5), porch(0, -2, 5.5), hedge(0, 3.3, 6, 0.5), tree(-2.8, -2.7, 0.6)]),
  design('pavilion', 'Pocket pavilion', 'expensive', 1, 1, [block(-1, 0, 3.3, 5.3, hip('y'), 5), wing(1.7, 1.3, 2, 2.6, flat), pool(1.9, -1.4, 1.3, 2.3)]),
  design('terrace', 'Terrace villa', 'expensive', 1, 1, [block(0, 1.5, 5.6, 2.6, flat, 5.5), wing(-1.9, -0.8, 1.8, 3.5, flat), pool(1.3, -1, 2, 2.8), hedge(0, -3.4, 6, 0.4)]),
  design('laurel', 'Laurel villa', 'expensive', 2, 2, [block(-1, 1, 8, 7, hip(), 6), wing(-3, -3, 4, 4, hip('y')), pool(4.5, 1, 3, 7), hedge(0, 6.5, 13, 0.7), tree(-5, 5)]),
  design('olive', 'Olive courtyard', 'expensive', 2, 2, [block(0, 3, 10, 4, flat, 5), wing(-3.5, -1, 3, 5, flat), garage(3.5, -1, 3, 5), pool(0, -1, 2.6, 4), hedge(0, 6.5, 13, 0.7), tree(-6, -5)]),
  design('cypress', 'Cypress estate', 'expensive', 3, 4, [block(-2, -3, 12, 8, hip(), 6), wing(-6, 3, 4, 8, hip('y')), wing(3, 2, 5, 6, hip('y')), garage(7, -5, 5, 7), pool(3, 9, 5, 7), hedge(0, 14, 21, 1), hedge(-10, 3, 1, 20), tree(-6, 11, 2), tree(8, 11, 2)]),
  business('corner-market', 'Corner Market', 'shops', 1, [block(0, 0.8, 5.6, 4.2, flat), awning(0, -1.9, 5.8)]),
  business('lime-cafe', 'Lime Café', 'shops', 1, [block(-1, 0.8, 3.5, 4.5, gable('y')), porch(1.8, -0.5, 2, 4), awning(-1, -2.0, 3.5), tree(2, 2.4, 0.8)]),
  business('bread-shop', 'Alder Bakery', 'shops', 1, [block(0, 0, 4.8, 4.8, hip()), chimney(1.5, 1), awning(0, -2.9, 4)]),
  business('fresh-grocer', 'Orchard Grocer', 'shops', 2, [block(-1, 1, 9, 6, flat, 4), awning(-1, -2.9, 9, 2), garage(4.8, 3)]),
  business('arcade', 'Market Row', 'shops', 2, [-4, 0, 4].flatMap(x => [block(x, 1, 3.8, 7, gable('y'), 4), awning(x, -3.1, 3.6)])),
  business('flower-shop', 'Meadow Florist', 'shops', 2, [block(-2, 1, 6, 7, hip()), wing(3, 2, 4, 5, gable('y')), awning(-2, -3.2, 5.8), hedge(3, -3, 5, 1), tree(5, 5)]),
  business('fern-workshop', 'Fern Workshop', 'workplaces', 1, [block(-0.8, 0, 3.5, 5.5, gable('y')), garage(1.8, 1, 1.6, 3.5)]),
  business('survey-office', 'Vale Survey Office', 'workplaces', 1, [block(0, 0.5, 5.2, 4.4, flat, 4.6), porch(-1, -2.2), tree(2.5, -2.6, 0.6)]),
  business('kiln', 'Willow Pottery', 'workplaces', 1, [block(0, 0, 4.7, 5, gable()), chimney(-1.4, 1.5)]),
  business('warehouse', 'Depot Warehouse', 'workplaces', 2, [block(0, 1, 11, 7, gable(), 4.8), porch(0, -3, 10, 2)]),
  business('timber-yard', 'Birch Timber Yard', 'workplaces', 2, [garage(-4, 2, 3.6, 7), garage(1, 3, 4, 5), block(4, -3, 3, 4, flat)]),
  business('studios', 'Station Studios', 'workplaces', 2, [block(-2, 0, 6, 9, flat, 5), wing(3, 2, 4, 5, flat), tree(4, -4)]),
];
