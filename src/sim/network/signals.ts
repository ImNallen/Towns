/** Fixed 50-second cycle at 20 ticks per second. Both changes include amber and clearance. */
export function signalAspect(group: number, tick: number): 'green' | 'amber' | 'red' {
  const t = tick % 1000;
  if (group === 0) return t < 500 ? 'green' : t < 560 ? 'amber' : 'red';
  return t < 600 ? 'red' : t < 900 ? 'green' : t < 960 ? 'amber' : 'red';
}
