import type { Scenario, ScenarioName } from '../sim/scenarios';
import type { SimStats } from '../sim/world';

/** Main thread → simulation worker. */
export type ToWorker =
  | { type: 'init'; scenario: ScenarioName; seed: number; speed: number }
  /** Simulation speed multiplier; 0 pauses. */
  | { type: 'setSpeed'; speed: number };

/** Simulation worker → main thread. */
export type FromWorker =
  | { type: 'ready'; scenario: Scenario; capacity: number }
  | {
      type: 'frame';
      tick: number;
      /** Number of vehicle slots in this frame. */
      slots: number;
      /** Per slot: x, y, heading (radians). */
      positions: Float32Array;
      /** Per slot vehicle id, -1 for empty slots. */
      ids: Int32Array;
      stats: SimStats;
    };
