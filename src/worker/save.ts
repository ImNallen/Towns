import { ROAD_TYPES } from '../sim/network/roadTypes';
import { isScenarioName, type ScenarioName } from '../sim/scenarios';
import type { ToWorker } from './protocol';

export type EditCommand = Exclude<ToWorker, { type: 'init' | 'save' | 'load' | 'cancelLoad' | 'setSpeed' }> | { type: 'retry' };
export interface InitialTown { scenario: ScenarioName; seed: number; walkLimit?: number }
export interface ReplayEvent { tick: number; command: EditCommand }
export interface TownSave extends InitialTown { version: 1; tick: number; events: ReplayEvent[] }

const record = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const integer = (v: unknown): v is number => finite(v) && Number.isSafeInteger(v) && v >= 0;
const point = (v: unknown) => record(v) && finite(v.x) && finite(v.y) && Math.abs(v.x) < 100000 && Math.abs(v.y) < 100000;
const roadType = (v: unknown) => typeof v === 'string' && Object.hasOwn(ROAD_TYPES, v);

function command(v: unknown): v is EditCommand {
  if (!record(v)) return false;
  switch (v.type) {
    case 'buildRoad': return point(v.start) && point(v.end) && (v.bend === undefined || point(v.bend)) && (v.roadType === undefined || roadType(v.roadType));
    case 'buildWalk': return point(v.start) && point(v.end) && (v.walk === 'zebra' || v.walk === 'footpath');
    case 'buildLights': return point(v.point) && typeof v.actuated === 'boolean';
    case 'upgradeRoad': return integer(v.segment) && integer(v.editCount) && roadType(v.roadType);
    case 'bulldozeRoad': return integer(v.segment) && integer(v.editCount);
    case 'paintZone': return (v.zone === null || ['residential','shops','workplaces','parking','park'].some(use => use === v.zone))
      && Array.isArray(v.cells) && v.cells.every(integer);
    case 'undo': case 'cancelRoadEdit': case 'retry': return true;
    default: return false;
  }
}

export function parseSave(json: string): TownSave {
  let data: unknown;
  try { data = JSON.parse(json); } catch { throw new Error('This file is not valid JSON.'); }
  if (!record(data)) throw new Error('Invalid town save.');
  if (data.version !== 1) throw new Error('Unsupported town save version. This game reads version 1.');
  if (typeof data.scenario !== 'string' || !isScenarioName(data.scenario) || !finite(data.seed)
    || !(data.walkLimit === undefined || (finite(data.walkLimit) && data.walkLimit >= 0))
    || !integer(data.tick) || !Array.isArray(data.events)) throw new Error('Invalid town save settings.');
  const finalTick = data.tick;
  let previous = 0;
  const events: ReplayEvent[] = data.events.map((event: unknown) => {
    if (!record(event) || !integer(event.tick) || event.tick < previous || event.tick > finalTick || !command(event.command))
      throw new Error('Invalid town edit history.');
    previous = event.tick;
    return { tick: event.tick, command: event.command };
  });
  return { version: 1, scenario: data.scenario, seed: data.seed, walkLimit: data.walkLimit, tick: data.tick, events };
}
