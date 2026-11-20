/**
 * Intelligent Driver Model (Treiber et al.): car-following acceleration.
 * Hot path: only + - * / and sqrt, which are bit-identical on every platform.
 */
export const IDM = {
  /** Max acceleration, m/s². */
  accel: 1.4,
  /** Comfortable deceleration, m/s². */
  decel: 2.0,
  /** Jam distance (bumper to bumper when stopped), m. */
  minGap: 2.0,
  /** Desired time headway, s. */
  headway: 1.3,
  /** Physical braking limit, m/s². */
  maxDecel: 8.0,
} as const;

export const VEHICLE_LENGTH = 4.5;

const TWO_SQRT_AB = 2 * Math.sqrt(IDM.accel * IDM.decel);

/**
 * @param v own speed (m/s)
 * @param v0 desired speed (m/s)
 * @param gap bumper-to-bumper distance to the obstacle ahead (Infinity = free road)
 * @param dv approach rate: own speed minus leader speed
 */
export function idmAccel(v: number, v0: number, gap: number, dv: number): number {
  const r = v / v0;
  const r2 = r * r;
  const free = 1 - r2 * r2;
  if (gap === Infinity) return IDM.accel * free;
  const desired = IDM.minGap + Math.max(0, v * IDM.headway + (v * dv) / TWO_SQRT_AB);
  const q = desired / Math.max(gap, 0.01);
  return Math.max(IDM.accel * (free - q * q), -IDM.maxDecel);
}
