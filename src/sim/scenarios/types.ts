import type { Network } from '../network/types';

/** Vehicles entering the map at the start of a source lane. */
export interface Demand {
  lane: number;
  /** Mean arrivals per second. */
  rate: number;
}

export interface House {
  x: number;
  y: number;
  /** Radians; the house's long axis (ridge) direction. */
  angle: number;
  /** Variant index, used for colour. */
  variant: number;
}

/** Organic closed shape (lake, hill contour). */
export interface Blob {
  x: number;
  y: number;
  radius: number;
  seed: number;
}

export interface Hill extends Blob {
  levels: number;
}

/** Static scenery. Visual only for now; buildings become simulated entities later. */
export interface Decor {
  houses: House[];
  lakes: Blob[];
  hills: Hill[];
}

export interface Bounds {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

export interface Scenario {
  name: string;
  network: Network;
  demand: Demand[];
  decor: Decor;
  bounds: Bounds;
}
