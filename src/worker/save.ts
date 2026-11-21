import { ROAD_TYPES } from '../sim/network/roadTypes';
import { isScenarioName, type ScenarioName } from '../sim/scenarios';
import type { MeadowEdit } from '../sim/scenarios/meadow';
import { ZONE_ROWS } from '../sim/zoning/cells';
import type { ParcelSlot } from '../sim/zoning/lots';
import type { ToWorker } from './protocol';

export const SAVE_VERSION = 3;
export type EditCommand = Exclude<ToWorker, { type: 'init' | 'save' | 'load' | 'cancelLoad' | 'setSpeed' }> | { type: 'retry' };
export interface InitialTown { scenario: ScenarioName; seed: number; walkLimit?: number }
export interface ReplayEvent { tick: number; command: EditCommand }
export interface Checkpoint {
  tick: number;
  eventCount: number;
  edits: MeadowEdit[];
  parcels: (ParcelSlot | null)[];
  hash: string;
  state: string;
}
export type TownSave = InitialTown & { tick: number; events: ReplayEvent[] } & (
  { version: 1 } | { version: typeof SAVE_VERSION; snapshot?: Checkpoint }
);

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

function edit(v: unknown): v is MeadowEdit {
  if (!record(v)) return false;
  if ('zone' in v) return command({ ...v, type: 'paintZone' });
  if ('remove' in v) return integer(v.remove);
  if ('upgrade' in v) return integer(v.upgrade) && roadType(v.roadType);
  if ('lights' in v) return point(v.lights) && (v.actuated === undefined || typeof v.actuated === 'boolean');
  if ('walk' in v) return (v.walk === 'zebra' || v.walk === 'footpath') && point(v.a) && point(v.b);
  return Array.isArray(v.points) && v.points.length >= 2 && v.points.every(point)
    && (v.roadType === undefined || roadType(v.roadType))
    && (v.fourWays === undefined || (Array.isArray(v.fourWays) && v.fourWays.every(c => record(c) && point(c.point) && point(c.priorityAxis))));
}

function checkpoint(v: unknown, tick: number, events: ReplayEvent[]): v is Checkpoint {
  if (!record(v) || !integer(v.tick) || v.tick > tick || !integer(v.eventCount) || v.eventCount > events.length
    || (events[v.eventCount - 1]?.tick ?? 0) > v.tick || (events[v.eventCount]?.tick ?? tick) < v.tick
    || typeof v.state !== 'string' || typeof v.hash !== 'string' || !Array.isArray(v.edits)
    || v.edits.length > v.eventCount || !v.edits.every(edit) || !Array.isArray(v.parcels)) return false;
  // A stroke can allocate at most one parcel slot per painted cell, including brush depth.
  // Empty slots are retained when parcels disappear, so use the history up to capture.
  let maxSlots = 0;
  for (let i = 0; i < v.eventCount; i++) {
    const cmd = events[i]!.command;
    if (cmd.type === 'paintZone') maxSlots += cmd.cells.length * ZONE_ROWS;
  }
  if (v.parcels.length > maxSlots) return false;
  return v.parcels.every(slot => slot === null || (record(slot) && integer(slot.key)
    && Array.isArray(slot.designs) && slot.designs.length >= 1 && slot.designs.length <= 3
    && slot.designs.every(d => Array.isArray(d) && d.length === 4 && typeof d[0] === 'string'
      && integer(d[1]) && integer(d[2]) && typeof d[3] === 'boolean')));
}

export function parseSave(json: string): TownSave {
  let data: unknown;
  try { data = JSON.parse(json); } catch { throw new Error('This file is not valid JSON.'); }
  if (!record(data)) throw new Error('Invalid town save.');
  if (data.version !== 1 && data.version !== SAVE_VERSION) throw new Error('Unsupported town save version. This game reads versions 1 and 3.');
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
  const base = { scenario: data.scenario, seed: data.seed, walkLimit: data.walkLimit, tick: data.tick, events };
  if (data.version === 1) return { version: 1, ...base };
  if (data.snapshot !== undefined && !checkpoint(data.snapshot, data.tick, events)) throw new Error('Invalid town snapshot.');
  return { version: SAVE_VERSION, ...base, snapshot: data.snapshot };

}
