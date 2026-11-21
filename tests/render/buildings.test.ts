import { expect, test } from 'vitest';
import { CELL_WIDTH, CELL_DEPTH, ZONE_ROWS } from '../../src/sim/zoning/cells';
import { BLUEPRINTS } from '../../src/render/buildings/catalogue';
import { buildingGeometry, buildBuildingLayer } from '../../src/render/buildings/mesh';
import { pickBuilding, variants } from '../../src/render/buildings/variation';

const tiers = ['cheap', 'mid', 'expensive'] as const;

test('each lot fits a repeatable design even between two different neighbours', () => {
  for (const tier of tiers) {
    for (let columns = 1; columns <= 5; columns++) {
      for (let rows = 1; rows <= ZONE_ROWS; rows++) {
        const lot = { columns, rows };
        const neighbours: string[] = [];
        for (let i = 0; i < 3; i++) {
          const pick = pickBuilding('road/17', tier, lot, neighbours);
          expect(pick).toEqual(pickBuilding('road/17', tier, lot, neighbours));
          expect(pick.blueprint.tier).toBe(tier);
          expect(pick.blueprint.lot.columns).toBeLessThanOrEqual(columns);
          expect(pick.blueprint.lot.rows).toBeLessThanOrEqual(rows);
          expect(neighbours).not.toContain(pick.blueprint.id);
          neighbours.push(pick.blueprint.id);
        }
      }
    }
  }
});

test('upgrades fit the same parcel and every finish stays inside the authored lot', () => {
  expect(new Set(BLUEPRINTS.map(b => b.id)).size).toBe(BLUEPRINTS.length);
  for (const blueprint of BLUEPRINTS) {
    if (blueprint.tier !== 'expensive') {
      const next = BLUEPRINTS.find(b => b.id === blueprint.upgradesTo);
      expect(next?.tier).toBe(tiers[tiers.indexOf(blueprint.tier) + 1]);
      expect(next!.lot.columns).toBeLessThanOrEqual(blueprint.lot.columns);
      expect(next!.lot.rows).toBeLessThanOrEqual(blueprint.lot.rows);
    }
    for (const finish of variants(blueprint)) {
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
  const pair = variants(BLUEPRINTS[0]).slice(0, 2);
  const layer = buildBuildingLayer([pair[0], pair[0], pair[1]].map((variant, i) => ({
    blueprint: BLUEPRINTS[0], variant, x: i * CELL_WIDTH, y: 0, angle: 0,
  })));
  expect(layer.children).toHaveLength(2);
});
