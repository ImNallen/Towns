import { createSession } from '../src/worker/session';
import type { EditCommand } from '../src/worker/save';
import { decodeCellKey, type CellKey } from '../src/sim/zoning/cells';
import type { LandUse } from '../src/sim/zoning/paint';
import type { RoadType } from '../src/sim/network/roadTypes';

export function plantValley() {
  const session = createSession({ scenario: 'valley', seed: 1 }, (message) => {
    if (message.type === 'editRejected') throw new Error(message.reason);
  });
  // Capital grant for the benchmark subdivision. The playable map starts with the normal treasury.
  session.world.treasury!.balance += 150000;
  function apply(command: EditCommand) {
    session.command(command);
    session.world.step();
  }
  function road(x: number, y: number, ex: number, ey: number, roadType: RoadType) {
    apply({ type: 'buildRoad', start: { x, y }, end: { x: ex, y: ey }, roadType });
  }
  road(-870, 0, 180, 0, 'town');
  road(-800, 0, -800, -670, 'avenue');
  for (const y of [-100, -200, -300, -400, -500, -600]) road(-800, y, 160, y, 'town');
  road(-320, -630, -320, 0, 'town');
  road(80, -630, 80, 0, 'town');
  road(160, -300, 230, -300, 'parking');
  for (const [i, j] of session.world.network.junctions!.entries()) {
    if (i >= 3) break;
    apply({ type: 'buildLights', point: j.point, actuated: i % 2 === 0 });
  }
  for (const y of [-100, -300, -500]) {
    const p = { x: -420, y };
    apply({ type: 'buildWalk', walk: 'zebra', start: p, end: p });
  }

  const cells = session.world.scenario.zones!;
  const released = new Set<CellKey>();
  function releaseDistrict(target: number) {
    const byUse = new Map<LandUse, CellKey[]>();
    for (let i = 0; i < cells.count; i++) {
      const key = cells.keys[i]! as CellKey;
      if (released.has(key)) continue;
      const { row, column, side } = decodeCellKey(key);
      if (row !== 0) continue;
      const x = cells.corners[i * 8]!;
      const y = cells.corners[i * 8 + 1]!;
      if (target <= 150 && (x > -480 || y < -225)) continue;
      if (target <= 500 && (x > -140 || y < -425)) continue;
      released.add(key);
      let use: LandUse = 'residential';
      if (column % 61 === 10 && side === 1) use = 'parking';
      else if (column % 30 === 5) use = 'shops';
      else if (column % 19 === 2) use = 'workplaces';
      const keys = byUse.get(use) ?? [];
      // Two-deep paint leaves room for detached homes, yards, and business bays.
      keys.push(use === 'parking' ? key : ((key + 1) as CellKey));
      byUse.set(use, keys);
    }
    const residential = byUse.get('residential')!;
    const park = (residential.shift()! - 1) as CellKey;
    const paint = (zone: LandUse, cells: CellKey[]) => apply({ type: 'paintZone', zone, cells });
    paint('park', [park]);
    for (const use of ['parking', 'shops', 'workplaces', 'residential'] as const) {
      const keys = byUse.get(use);
      if (keys?.length) paint(use, keys);
    }
  }
  return { session, releaseDistrict };
}

export function growTo(town: ReturnType<typeof plantValley>, target: number) {
  const { world } = town.session;
  town.releaseDistrict(target);
  let count = 0;
  while (count < target) {
    for (let i = 0; i < 400; i++) world.step();
    count = world.townView()!.households.length;
    if (world.stats().lost || world.tick > 500000)
      throw new Error(JSON.stringify({ target, count, tick: world.tick, lost: world.stats().lost }));
  }
  return count;
}
