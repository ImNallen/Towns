import { describe, expect, it } from 'vitest';
import { runEditSequence, sameLaneOverlaps } from '../../scripts/edits';
import { DT } from '../../src/sim/world';

describe('road edits under live traffic', () => {
  const { rows, world } = runEditSequence(7);

  it('applies every edit at once without overlaps, and clears cars only where roads change under them', () => {
    expect(rows.map((row) => row.edit)).toEqual([
      'connect with an arch', 'T junction on the arch', 'bypass across the arch',
      'four-way across the bypass', 'bulldoze a bypass segment', 'undo the bulldozing',
    ]);
    expect(rows.slice(1).every((row) => row.active > 5)).toBe(true);
    expect(rows.every((row) => row.overlaps === 0)).toBe(true);
    expect(rows.find((row) => row.edit === 'bulldoze a bypass segment')!.cleared).toBeGreaterThan(0);
    const cleared = Object.fromEntries(rows.map((row) => [row.edit, row.cleared]));
    expect(cleared).toMatchObject({
      'T junction on the arch': 0, 'bypass across the arch': 0, 'four-way across the bypass': 0, 'undo the bulldozing': 0,
    });
    expect(world.stats().cleared).toBe(rows.reduce((sum, row) => sum + row.cleared, 0));
    expect(world.stats().lost).toBe(0);
  });

  it('keeps completing trips after every edit', () => {
    const { rows, world } = runEditSequence(7);
    for (let i = 1; i < rows.length; i++) expect(rows[i]!.completed).toBeGreaterThan(rows[i - 1]!.completed);
    const completed = world.stats().completed;
    let overlaps = 0;
    for (let t = 0; t < 120 / DT; t++) {
      world.step();
      if (t % 5 === 0) overlaps += sameLaneOverlaps(world);
    }
    expect(overlaps).toBe(0);
    expect(world.stats().completed).toBeGreaterThan(completed + 10);
    expect(world.stats().lost).toBe(0);
  });

  it('reproduces the same state for the same seed and edits', () => {
    const again = runEditSequence(7);
    expect(again.rows).toEqual(rows);
    expect(again.world.hash()).toBe(world.hash());
    expect(runEditSequence(8).world.hash()).not.toBe(world.hash());
  });
});
