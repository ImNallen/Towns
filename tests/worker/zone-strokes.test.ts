import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { cellKey, type RoadIndex } from '../../src/sim/zoning/cells';
import type { FromWorker, ToWorker } from '../../src/worker/protocol';

const posted: FromWorker[] = [];
const worker = { postMessage: (msg: FromWorker) => posted.push(msg), onmessage: null as ((e: { data: ToWorker }) => void) | null };
const send = (msg: ToWorker) => worker.onmessage!({ data: msg });
const drain = () => posted.splice(0);
const run = (seconds: number) => vi.advanceTimersByTime(seconds * 1000);
const lastFrame = (msgs: FromWorker[]) => msgs.filter((m) => m.type === 'frame').at(-1)!;
const backRow = Array.from({ length: 6 }, (_, c) => cellKey(1 as RoadIndex, c + 2, 0, 3));

beforeAll(async () => {
  vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'performance'] });
  vi.stubGlobal('self', worker);
  await import('../../src/worker/sim.worker');
});
afterAll(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('the simulation worker', () => {
  it('applies a stroke and its undo without touching the roads or the World', () => {
    send({ type: 'init', scenario: 'meadow', seed: 1, speed: 4 });
    let frame = lastFrame(drain());
    for (let t = 0; t < 120 && frame.stats.active === 0; t++) {
      run(1);
      frame = lastFrame(drain());
    }
    expect(frame.stats.active).toBeGreaterThan(0);

    send({ type: 'paintZone', zone: 'residential', cells: backRow });
    const [painted, ...rest] = drain();
    expect(rest).toEqual([]);
    expect(painted).toMatchObject({ type: 'zoningChanged', edits: [{ zone: 'residential' }] });
    if (painted?.type !== 'zoningChanged') throw new Error('expected zoningChanged');
    expect(painted.edits[0]).toMatchObject({ cells: expect.arrayContaining(backRow) });

    send({ type: 'paintZone', zone: 'residential', cells: backRow });
    expect(drain()).toEqual([{ type: 'editRejected', reason: 'Already zoned residential.' }]);

    send({ type: 'undo' });
    expect(drain()).toEqual([{ type: 'zoningChanged', edits: [] }]);
    run(0.1);
    const next = lastFrame(drain());
    expect(next.tick).toBeGreaterThan(frame.tick);
    const driving = (f: typeof frame) => [...f.ids.slice(0, f.slots)].filter((id) => id >= 0);
    expect(driving(next)).toEqual(expect.arrayContaining(driving(frame)));
  });

  it('still rebuilds the roads for a road edit and its undo', () => {
    send({ type: 'buildRoad', start: { x: -65, y: 62 }, end: { x: -65, y: -8 } });
    expect(drain().map((m) => m.type)).toContain('roadsChanged');
    send({ type: 'undo' });
    expect(drain().map((m) => m.type)).toContain('roadsChanged');
  });
});
