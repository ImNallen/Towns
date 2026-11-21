/** Travel preferences apply once per errand. Distances are pavement-route metres. */
export const WALK_CHOICE = {
  near: 150,
  middle: 350,
  far: 500,
  nearChance: 0.94,
  middleChance: 0.5,
  farChance: 0.08,
  groceries: 0.45,
  youngFamily: 0.6,
  carNearDestination: 0.45,
  groceryParkingRange: 65,
  carFreeRange: 1.5,
};

const lerp = (a: number, b: number, t: number) => a + (b - a) * t;

export function walkChance(
  distance: number,
  limit: number,
  carFree: boolean,
  groceries: boolean,
  youngFamily: boolean,
  carNearDestination: boolean,
): number {
  const c = WALK_CHOICE;
  if (carFree) return distance <= limit * c.carFreeRange ? 1 : 0;
  if (distance >= limit) return 0;

  const chance =
    distance <= c.near
      ? c.nearChance
      : distance < c.middle
        ? lerp(c.nearChance, c.middleChance, (distance - c.near) / (c.middle - c.near))
        : distance < c.far
          ? lerp(c.middleChance, c.farChance, (distance - c.middle) / (c.far - c.middle))
          : (c.farChance * (limit - distance)) / (limit - c.far);
  return (
    chance *
    (groceries ? c.groceries : 1) *
    (youngFamily ? c.youngFamily : 1) *
    (carNearDestination ? c.carNearDestination : 1)
  );
}
