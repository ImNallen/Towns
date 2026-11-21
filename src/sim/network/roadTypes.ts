import { BUDGET } from '../town/economy';

export type RoadType = 'country' | 'town' | 'parking';
type Side = 'left' | 'right' | 'both';
export interface RoadStrip {
  kind: 'pavement' | 'parking';
  side: Side;
  width: number;
}

export interface CrossSection {
  name: string;
  lanesPerDirection: number;
  laneWidth: number;
  speedLimit: number;
  cost: number;
  upkeep: number;
  strips: readonly RoadStrip[];
}

const pavement: RoadStrip = { kind: 'pavement', side: 'both', width: 1.5 };
export const ROAD_TYPES: Record<RoadType, CrossSection> = {
  country: { name: 'Country lane', lanesPerDirection: 1, laneWidth: 3.5, speedLimit: 16.7, cost: 8, upkeep: 0.8, strips: [] },
  town: { name: 'Town street', lanesPerDirection: 1, laneWidth: 3.5, speedLimit: 11.1, cost: BUDGET.roadPerMetre, upkeep: BUDGET.upkeepPerMetre, strips: [pavement] },
  parking: { name: 'Town street with parking', lanesPerDirection: 1, laneWidth: 3.5, speedLimit: 8.3, cost: 18, upkeep: 2, strips: [{ kind: 'parking', side: 'both', width: 2.2 }, pavement] },
};
export const ROAD_ORDER: readonly RoadType[] = ['country', 'town', 'parking'];

export function edgeOffset(type: RoadType, side: 'left' | 'right'): number {
  const spec = ROAD_TYPES[type];
  return spec.strips.reduce((edge, strip) => edge + (strip.side === 'both' || strip.side === side ? strip.width : 0), spec.lanesPerDirection * spec.laneWidth);
}
