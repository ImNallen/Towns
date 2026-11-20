import { describe, expect, it } from 'vitest';
import { arcPoints } from '../../src/sim/math/curves';
import { endOf, offsetPolyline, polyline, sampleAt, startOf } from '../../src/sim/math/polyline';
import { Rng } from '../../src/sim/rng';

describe('polyline', () => {
  it('measures and samples by arc length', () => {
    const pl = polyline([{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }]);
    expect(pl.length).toBe(20);
    const p = sampleAt(pl, 15, { x: 0, y: 0, hx: 0, hy: 0 });
    expect(p).toEqual({ x: 10, y: 5, hx: 0, hy: 1 });
  });

  it('clamps samples outside the path', () => {
    const pl = polyline([{ x: 0, y: 0 }, { x: 10, y: 0 }]);
    expect(sampleAt(pl, -5, { x: 0, y: 0, hx: 0, hy: 0 }).x).toBe(0);
    expect(sampleAt(pl, 50, { x: 0, y: 0, hx: 0, hy: 0 }).x).toBe(10);
  });

  it('offsets to the left of travel for positive distances', () => {
    const pl = offsetPolyline(polyline([{ x: 0, y: 0 }, { x: 10, y: 0 }]), 2);
    expect(startOf(pl).y).toBeCloseTo(2);
    expect(endOf(pl).y).toBeCloseTo(2);
  });

  it('keeps constant width around corners', () => {
    const pl = offsetPolyline(polyline([{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }]), -1);
    const corner = { x: pl.pts[2]!, y: pl.pts[3]! };
    expect(corner.x).toBeCloseTo(11);
    expect(corner.y).toBeCloseTo(-1);
  });

  it('closes loops', () => {
    const ring = polyline(arcPoints({ x: 0, y: 0 }, 10, 0, Math.PI * 2, 1, false), true);
    expect(ring.length).toBeCloseTo(2 * Math.PI * 10, 0);
    expect(endOf(ring).x).toBeCloseTo(startOf(ring).x);
  });
});

describe('rng', () => {
  it('is deterministic per seed', () => {
    const a = new Rng(42);
    const b = new Rng(42);
    const c = new Rng(43);
    const seqA = Array.from({ length: 5 }, () => a.nextU32());
    expect(Array.from({ length: 5 }, () => b.nextU32())).toEqual(seqA);
    expect(Array.from({ length: 5 }, () => c.nextU32())).not.toEqual(seqA);
  });

  it('stays in [0, 1)', () => {
    const r = new Rng(1);
    for (let i = 0; i < 10_000; i++) {
      const x = r.next();
      expect(x >= 0 && x < 1).toBe(true);
    }
  });
});
