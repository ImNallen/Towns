import { expect, it } from 'vitest';
import { endOf, startOf } from '../../src/sim/math/polyline';
import { distance, vec2, type Vec2 } from '../../src/sim/math/vec';
import { meadowConnected, meadowScenario, meadowSnap, meadowStreets, planMeadowRoad, type MeadowRoad } from '../../src/sim/scenarios/meadow';
import { Routing } from '../../src/sim/traffic/routing';
import { DT, World } from '../../src/sim/world';

function build(roads: MeadowRoad[], from: Vec2, to: Vec2): MeadowRoad {
  const plan = planMeadowRoad(roads, from, to);
  if (!plan.ok) throw new Error(plan.reason);
  roads.push(plan.road);
  return plan.road;
}

const center = vec2(-65, -8);
const north = vec2(-65, 62);
const south = vec2(-65, -44);

it('splits the existing street and the new street at one exact four-way node in either drag direction', () => {
  for (const [from, to] of [[north, south], [south, north]] as const) {
    const roads: MeadowRoad[] = [];
    const road = build(roads, from, to);
    expect(road.fourWays).toHaveLength(1);
    const node = road.fourWays![0]!.point;
    expect(distance(node, center)).toBeLessThan(1e-8);
    const incident = meadowStreets(structuredClone(roads)).filter((street) => [street[0], street.at(-1)].some((end) => end?.x === node.x && end.y === node.y));
    expect(incident).toHaveLength(4);
    expect(meadowScenario(roads).network.lanes.filter((l) => l.kind === 'connector')).toHaveLength(12);
    expect(meadowSnap(roads, node, 1)).toBeUndefined();
    expect(planMeadowRoad(roads, node, vec2(-40, -50)).ok).toBe(false);
    roads.pop();
    expect(meadowStreets(roads)).toHaveLength(2);
  }
});

it('extends only the missing arm of a T and restores its six movements on undo', () => {
  const roads: MeadowRoad[] = [];
  build(roads, center, north);
  const before = meadowScenario(roads);
  expect(meadowSnap(roads, vec2(-64, -7), 3)).toEqual(center);
  expect(planMeadowRoad(roads, center, vec2(-65, 48)).ok).toBe(false);
  const upgrade = build(roads, center, south);
  expect(upgrade.fourWays).toHaveLength(1);
  expect(meadowScenario(roads).network.lanes.filter((l) => l.kind === 'connector')).toHaveLength(12);
  roads.pop();
  expect(meadowScenario(roads)).toEqual(before);
  expect(build(roads, south, center).fourWays?.[0]?.point).toEqual(center);
});

it('keeps the older curved street as the through road when crossing an exact curve vertex', () => {
  const arch = planMeadowRoad([], vec2(-45, -8), vec2(45, 8), vec2(0, 20));
  if (!arch.ok) throw new Error(arch.reason);
  const roads = [arch.road];
  expect(build(roads, vec2(0, -45), vec2(0, 65)).fourWays).toHaveLength(1);
  const { network, demand } = meadowScenario(roads);
  const routing = new Routing(network);
  for (const [index, entry] of demand.entries()) {
    const through = network.lanes[routing.nextHop(1 - index, entry.lane)]!;
    expect(through.kind).toBe('connector');
    expect(through.crossingYieldTo).toHaveLength(0);
  }
});

it('rejects shallow crossings, short arms and crossings too close to a junction', () => {
  const roads: MeadowRoad[] = [];
  for (const [from, to] of [
    [vec2(-92, -18), vec2(-38, 2)],
    [vec2(-65, -15), north],
    [vec2(-51, -60), vec2(-51, 60)],
  ] as const) expect(planMeadowRoad(roads, from, to).ok).toBe(false);
  build(roads, center, north);
  expect(planMeadowRoad(roads, vec2(-59, -50), vec2(-59, 45)).ok).toBe(false);
});

it('builds a shorter route across an existing street and drives through the resulting intersection', () => {
  const roads: MeadowRoad[] = [];
  build(roads, center, vec2(-65, 75));
  build(roads, vec2(65, 8), vec2(65, 75));
  build(roads, vec2(-65, 45), vec2(65, 45));
  build(roads, vec2(0, 45), vec2(0, -40));
  expect(meadowConnected(roads)).toBe(true);
  const before = meadowScenario(roads);
  const shortcut = build(roads, vec2(-45, -8), vec2(45, 8));
  const node = shortcut.fourWays![0]!.point;
  const scenario = meadowScenario(roads);
  const network = scenario.network;
  const world = new World({ ...scenario, demand: [], town: undefined }, 1);
  const source = scenario.demand[0]!.lane;
  expect(world.routing.travelTime(1, source)).toBeLessThan(new Routing(before.network).travelTime(1, before.demand[0]!.lane));
  const car = world.vehicles.spawn(source, 0, 9, 1, 0);
  let crossed = false;
  for (let i = 0; i < 100 / DT && world.vehicles.alive[car]; i++) {
    const lane = network.lanes[world.vehicles.lane[car]!]!;
    if (!crossed && lane.kind === 'connector' && distance(startOf(lane.path), node) < 13 && distance(endOf(lane.path), node) < 13) {
      expect(world.editNetwork(before).ok).toBe(false);
      crossed = true;
    }
    world.step();
  }
  expect(crossed).toBe(true);
  expect(world.stats()).toMatchObject({ completed: 1, lost: 0 });
  const undo = world.editNetwork(before);
  if (!undo.ok) throw new Error(undo.reason);
  expect(undo.world.stats()).toEqual(world.stats());
});

it('builds multiple crossings in one drag and undoes them together', () => {
  const roads: MeadowRoad[] = [];
  build(roads, center, vec2(-65, 72));
  build(roads, vec2(65, 8), vec2(65, 72));
  const before = meadowScenario(roads);
  const crossbar = build(roads, vec2(-81, 45), vec2(81, 45));
  expect(crossbar.fourWays).toHaveLength(2);
  expect(meadowConnected(roads)).toBe(true);
  roads.pop();
  expect(meadowScenario(roads)).toEqual(before);
});
