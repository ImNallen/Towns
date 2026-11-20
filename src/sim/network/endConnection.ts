import { arcPoints } from '../math/curves';
import { add, cross, distance, dot, fromAngle, perp, scale, sub, type Vec2 } from '../math/vec';

const END_TURN_RADIUS = 20;
const LEAD = 0.5;
export const END_TURN_RUN = END_TURN_RADIUS + LEAD;
const STEP = 0.6;

function line(points: Vec2[], end: Vec2): void {
  const start = points[points.length - 1]!;
  const delta = sub(end, start);
  const length = distance(start, end);
  if (length < 1e-8) return;
  const count = Math.ceil(length / STEP);
  for (let i = 1; i < count; i++) points.push(add(start, scale(delta, i / count)));
  points.push(end);
}

export function roundedJunctionCorner(start: Vec2, end: Vec2, incoming: Vec2, outgoing: Vec2, minRadius: number): Vec2[] | undefined {
  const delta = sub(end, start);
  const divisor = cross(incoming, outgoing);
  if (Math.abs(divisor) < 1e-8) return undefined;
  const before = cross(delta, outgoing) / divisor;
  const after = cross(incoming, delta) / divisor;
  const sweep = Math.atan2(divisor, dot(incoming, outgoing));
  const trim = Math.tan(Math.abs(sweep) / 2);
  const radius = Math.min(END_TURN_RADIUS, (Math.min(before, after) - LEAD) / trim);
  if (radius < minRadius) return undefined;
  const corner = add(start, scale(incoming, before));
  const entry = sub(corner, scale(incoming, radius * trim));
  const exit = add(corner, scale(outgoing, radius * trim));
  const center = add(entry, scale(perp(incoming), Math.sign(sweep) * radius));
  const angle = Math.atan2(entry.y - center.y, entry.x - center.x);
  const points = [start];
  line(points, entry);
  points.push(...arcPoints(center, radius, angle, angle + sweep, STEP).slice(1, -1), exit);
  line(points, end);
  return points;
}

function turnAngle(from: number, to: number, turn: number): number {
  const circle = 2 * Math.PI;
  const sweep = turn * (to - from) % circle;
  return turn * (sweep < -1e-8 ? sweep + circle : sweep);
}

/** Shortest forward arc–straight–arc join; endpoint leads preserve exact tangents. */
export function compactEndConnection(start: Vec2, end: Vec2, incoming: Vec2, outgoing: Vec2, radius = 12): Vec2[] | undefined {
  const entry = add(start, scale(incoming, LEAD));
  const exit = sub(end, scale(outgoing, LEAD));
  let best: { points: Vec2[]; length: number } | undefined;
  for (const firstTurn of [-1, 1]) {
    for (const lastTurn of [-1, 1]) {
      const firstCenter = add(entry, scale(perp(incoming), firstTurn * radius));
      const lastCenter = add(exit, scale(perp(outgoing), lastTurn * radius));
      const delta = sub(lastCenter, firstCenter);
      const span = distance(firstCenter, lastCenter);
      const offset = (firstTurn - lastTurn) * radius;
      if (Math.abs(offset) > span + 1e-8) continue;
      const tangent = span < 1e-8 ? outgoing : fromAngle(
        Math.atan2(delta.y, delta.x) + Math.asin(Math.max(-1, Math.min(1, offset / span))),
      );
      const first = sub(firstCenter, scale(perp(tangent), firstTurn * radius));
      const last = sub(lastCenter, scale(perp(tangent), lastTurn * radius));
      const firstAngle = Math.atan2(entry.y - firstCenter.y, entry.x - firstCenter.x);
      const firstSweep = turnAngle(firstAngle, Math.atan2(first.y - firstCenter.y, first.x - firstCenter.x), firstTurn);
      const lastAngle = Math.atan2(last.y - lastCenter.y, last.x - lastCenter.x);
      const lastSweep = turnAngle(lastAngle, Math.atan2(exit.y - lastCenter.y, exit.x - lastCenter.x), lastTurn);
      if (Math.abs(firstSweep) > Math.PI + 1e-8 || Math.abs(lastSweep) > Math.PI + 1e-8) continue;
      const length = radius * (Math.abs(firstSweep) + Math.abs(lastSweep)) + distance(first, last);
      if (best && length >= best.length) continue;
      const points = [start, entry];
      if (Math.abs(firstSweep) > 1e-8) points.push(...arcPoints(firstCenter, radius, firstAngle, firstAngle + firstSweep, STEP).slice(1, -1));
      line(points, first);
      line(points, last);
      if (Math.abs(lastSweep) > 1e-8) points.push(...arcPoints(lastCenter, radius, lastAngle, lastAngle + lastSweep, STEP).slice(1, -1));
      line(points, exit);
      line(points, end);
      best = { points, length };
    }
  }
  return best?.points;
}
