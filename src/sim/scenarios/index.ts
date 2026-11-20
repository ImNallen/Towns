import { meadowScenario } from './meadow';
import { roundaboutTown } from './roundabout';
import { straightRoad } from './straight';
import type { Scenario } from './types';

export const SCENARIOS = {
  meadow: meadowScenario,
  roundabout: roundaboutTown,
  straight: straightRoad,
} as const satisfies Record<string, () => Scenario>;

export type ScenarioName = keyof typeof SCENARIOS;

export const isScenarioName = (name: string): name is ScenarioName => Object.hasOwn(SCENARIOS, name);

export function buildScenario(name: ScenarioName): Scenario {
  return SCENARIOS[name]();
}

export type { Scenario } from './types';
