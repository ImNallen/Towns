/**
 * Intelligent Driver Model (Treiber et al.): car-following acceleration.
 * Hot path: only + - * / and sqrt, which are bit-identical on every platform.
 */
export const IDM = {
  /** Jam distance (bumper to bumper when stopped), m. */
  minGap: 2.0,
  /** Desired time headway, s. */
  headway: 1.3,
  /** Physical braking limit, m/s². */
  maxDecel: 8.0,
} as const;

/**
 * @param v own speed (m/s)
 * @param v0 desired speed (m/s)
 * @param gap bumper-to-bumper distance to the obstacle ahead (Infinity = free road)
 * @param dv approach rate: own speed minus leader speed
 */
export function idmAccel(v: number, v0: number, gap: number, dv: number, accel: number, brake: number): number {
  const r = v / v0;
  const r2 = r * r;
  const free = 1 - r2 * r2;
  if (gap === Infinity) return accel * free;
  const desired = IDM.minGap + Math.max(0, v * IDM.headway + (v * dv) / (2 * Math.sqrt(accel * brake)));
  const q = desired / Math.max(gap, 0.01);
  return Math.max(accel * (free - q * q), -IDM.maxDecel);
}
