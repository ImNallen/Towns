import type { Polyline } from '../math/polyline';

export type LaneKind = 'road' | 'connector' | 'ring';

/**
 * A directed lane: the unit of traffic simulation. Vehicles move along `path`
 * by arc length and continue onto one of `next` at the end.
 */
export interface Lane {
  readonly id: number;
  readonly kind: LaneKind;
  readonly path: Polyline;
  readonly length: number;
  /** m/s */
  readonly speedLimit: number;
  readonly next: number[];
  readonly prev: number[];
  /**
   * Lanes with priority where this lane merges at its end (give way).
   * A yielding lane has exactly one `next`, which every priority lane also feeds.
   */
  readonly yieldTo: number[];
}

/** Drawable road surface. Purely visual; traffic only uses lanes. */
export type SurfaceStyle = 'twoWay' | 'oneWay' | 'junction' | 'driveway';

export interface Surface {
  readonly id: number;
  readonly style: SurfaceStyle;
  readonly centerline: Polyline;
  readonly width: number;
}

export interface Network {
  readonly lanes: Lane[];
  readonly surfaces: Surface[];
  /** Lanes with no predecessor: where vehicles enter the map. */
  readonly sources: number[];
  /** Lanes with no successor: where vehicles leave the map. */
  readonly sinks: number[];
}
