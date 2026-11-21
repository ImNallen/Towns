import type { RoadType } from '../sim/network/roadTypes';
import type { Vec2 } from '../sim/math/vec';
import type { Network } from '../sim/network/types';
import type { MeadowEdit } from '../sim/scenarios/meadow';
import type { Scenario, ScenarioName } from '../sim/scenarios';
import type { TownView } from '../sim/town/town';
import type { SimStats } from '../sim/world';
import type { CellKey, ZoneCells } from '../sim/zoning/cells';
import type { LandUse } from '../sim/zoning/paint';

/** Main thread → simulation worker. */
export type ToWorker =
  | { type: 'init'; walkLimit?: number; scenario: ScenarioName; seed: number; speed: number }
  /** Simulation speed multiplier; 0 pauses. */
  | { type: 'setSpeed'; speed: number }
  | { type: 'buildRoad'; roadType?: RoadType; start: Vec2; end: Vec2; bend?: Vec2 }
  | { type: 'upgradeRoad'; segment: number; editCount: number; roadType: RoadType }
  | { type: 'bulldozeRoad'; segment: number; editCount: number }
  /** Cells the brush passed over; the worker plans the stroke against its own edits. `zone: null` erases. */
  | { type: 'paintZone'; zone: LandUse | null; cells: readonly CellKey[] }
  | { type: 'undo' }
  | { type: 'cancelRoadEdit' };

/** Simulation worker → main thread. */
export type FromWorker =
  | { type: 'roadsChanged'; network: Network; zones: ZoneCells | undefined; edits: MeadowEdit[] }
  /** A stroke was added or undone. Roads and cells are still those of the last `ready` or `roadsChanged`. */
  | { type: 'zoningChanged'; edits: MeadowEdit[] }
  | { type: 'editWaiting' }
  | { type: 'editRejected'; reason: string }
  | { type: 'ready'; scenario: Scenario; capacity: number }
  /** Residents and their households, a few times a second while the map has a town. */
  | { type: 'town'; view: TownView }
  | {
      type: 'frame';
      tick: number;
      /** Number of vehicle slots in this frame. */
      slots: number;
      /** Per slot: x, y, heading (radians). */
      positions: Float32Array;
      walkers: Float32Array;
      /** Per slot vehicle id, -1 for empty slots. */
      ids: Int32Array;
      /** Catalogue model for each occupied slot. */
      models: Uint8Array;
      paint: Uint8Array;
      stats: SimStats;
    };
