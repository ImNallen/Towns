import type { Network } from '../network/types';
import type { AccessPoint } from '../traffic/routing';
import type { ZoneCells } from '../zoning/cells';

/** Vehicles entering the map at the start of a source lane. */
export interface Demand {
  lane: number;
  /** Mean arrivals per second. */
  rate: number;
}

export interface House {
  garden?: Bounds;
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

/** A driveway slot. The initial slots match decor.houses, followed by reusable zoned parcels. */
export interface HomeSpec {
  /** A painted parcel which may develop into housing or a business. */
  lot?: import('../zoning/lots').Lot;
  /** Where the driveway meets its street, one per direction. Empty when the street is gone. */
  access: AccessPoint[];
  /** The off-map town this neighbourhood grew up around. */
  region: number;
}

/** An off-map town behind a portal, where residents work and shop. */
export interface RegionSpec {
  name: string;
  /** Routing destination index (a sink) for trips into the region. */
  sink: number;
  /** Lane where trips leaving the region enter the map. */
  source: number;
  /** Per hour worked. */
  wage: number;
  jobs: number;
  /** Groceries, per person per day of food. */
  groceryPrice: number;
}

export interface TownSpec {
  homes: HomeSpec[];
  regions: RegionSpec[];
}

export interface Scenario {
  name: string;
  network: Network;
  demand: Demand[];
  decor: Decor;
  bounds: Bounds;
  /** Residents and the places they travel to. Absent for traffic-only maps. */
  town?: TownSpec;
  /** Zone cells beside the streets. Absent on maps without zoning. */
  zones?: ZoneCells;
}
