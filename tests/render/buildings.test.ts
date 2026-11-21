import { expect, test } from 'vitest';
import { CELL_WIDTH, CELL_DEPTH, ZONE_ROWS } from '../../src/sim/zoning/cells';
import { BLUEPRINTS } from '../../src/render/buildings/catalogue';
import { buildingGeometry, buildBuildingLayer } from '../../src/render/buildings/mesh';
import type { BuildingPick } from '../../src/render/buildings/types';
import { pickBuilding, catalogueVariants } from '../../src/render/buildings/variation';

const tiers = ['cheap', 'mid', 'expensive'] as const;

test('each lot fits a repeatable design even between two different neighbours', () => {
  for (const tier of tiers) {
    for (let columns = 1; columns <= 5; columns++) {
      for (let rows = 1; rows <= ZONE_ROWS; rows++) {
        const lot = { columns, rows };
        const neighbours: BuildingPick[] = [];
        for (let i = 0; i < 3; i++) {
          const pick = pickBuilding('road/17', tier, lot, neighbours);
          expect(pick).toEqual(pickBuilding('road/17', tier, lot, neighbours));
          expect(pick.blueprint.tier).toBe(tier);
          expect(pick.blueprint.lot.columns).toBeLessThanOrEqual(columns);
          expect(pick.blueprint.lot.rows).toBeLessThanOrEqual(rows);
          for (const n of neighbours) {
            expect(n.blueprint.id).not.toBe(pick.blueprint.id);
            expect([n.variant.wall, n.variant.roof]).not.toEqual([pick.variant.wall, pick.variant.roof]);
          }
          neighbours.push(pick);
        }
      }
    }
  }
});

test('upgrades fit the same parcel and each preview stays inside the authored lot', () => {
  expect(new Set(BLUEPRINTS.map(b => b.id)).size).toBe(BLUEPRINTS.length);
  for (const blueprint of BLUEPRINTS) {
    if (blueprint.tier !== 'expensive') {
      const next = BLUEPRINTS.find(b => b.id === blueprint.upgradesTo);
      expect(next?.tier).toBe(tiers[tiers.indexOf(blueprint.tier) + 1]);
      expect(next!.lot.columns).toBeLessThanOrEqual(blueprint.lot.columns);
      expect(next!.lot.rows).toBeLessThanOrEqual(blueprint.lot.rows);
    }
    for (const finish of catalogueVariants(blueprint)) {
      const geometry = buildingGeometry(blueprint, finish);
      geometry.computeBoundingBox();
      const { min, max } = geometry.boundingBox!;
      expect(Math.max(-min.x, max.x)).toBeLessThanOrEqual(blueprint.lot.columns * CELL_WIDTH / 2);
      expect(Math.max(-min.z, max.z)).toBeLessThanOrEqual(blueprint.lot.rows * CELL_DEPTH / 2);
      geometry.dispose();
    }
  }
});

test('repeated buildings share one draw per variant', () => {
  const pair = catalogueVariants(BLUEPRINTS[0]).slice(0, 2);
  const layer = buildBuildingLayer([pair[0], pair[0], pair[1]].map((variant, i) => ({
    blueprint: BLUEPRINTS[0], variant, x: i * CELL_WIDTH, y: 0, angle: 0,
  })));
  expect(layer.children).toHaveLength(2);
});

test('each permitted wall pairs with every permitted roof on the same design', () => {
  for (const tier of tiers) {
    const combos = new Map<string, Set<string>>();
    for (let i = 0; i < 4096; i++) {
      const { blueprint, variant } = pickBuilding(`colour-test/${i}`, tier, { columns: 1, rows: 1 });
      const finishes = combos.get(blueprint.id) ?? new Set<string>();
      finishes.add(`${variant.wall}/${variant.roof}`);
      combos.set(blueprint.id, finishes);
    }
    for (const b of BLUEPRINTS.filter(b => b.tier === tier && b.lot.columns === 1 && b.lot.rows === 1)) {
      expect(combos.get(b.id)).toEqual(new Set(b.walls.flatMap(w => b.roofs.map(r => `${w}/${r}`))));
    }
  }
});

test('both neighbouring finishes are excluded even when their designs and orientations differ', () => {
  const lot = { columns: 2, rows: 2 };
  const pick = () => pickBuilding('paint/31', 'mid', lot, neighbours);
  const neighbours: BuildingPick[] = [];
  const first = pick();
  const other = BLUEPRINTS.find(b => b.tier === 'mid' && b.id !== first.blueprint.id)!;
  for (let i = 0; i < 2; i++) {
    const { variant } = pick();
    neighbours.push({ blueprint: other, variant: { ...variant, mirrored: !variant.mirrored } });
  }
  const third = pick();
  expect(third.blueprint.id).toBe(first.blueprint.id);
  expect(third.variant.wall).toBe(first.variant.wall);
  expect(new Set([...neighbours.map(n => n.variant.roof), third.variant.roof]).size).toBe(3);
});
