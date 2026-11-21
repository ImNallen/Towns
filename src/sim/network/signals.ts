/** Fixed 50-second cycle at 20 ticks per second. Both changes include amber and clearance. */
export function signalAspect(group: number, tick: number): 'green' | 'amber' | 'red' {
  const t = tick % 1000;
  if (group === 0) return t < 500 ? 'green' : t < 560 ? 'amber' : 'red';
  return t < 600 ? 'red' : t < 900 ? 'green' : t < 960 ? 'amber' : 'red';
}

/** Advance one tick. Main rests on green until a call after its 10 s minimum.
 * Side gets 5–15 s, then both plans use identical amber and all-red intervals. */
export function nextActuatedClock(clock: number, sideCall: boolean): number {
  if (clock < 500) {
    if (sideCall && clock >= 199) return 500;
    return Math.min(clock + 1, 499);
  }
  if (clock >= 699 && clock < 900 && !sideCall) return 900;
  return (clock + 1) % 1000;
}
