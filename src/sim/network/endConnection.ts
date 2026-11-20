import { arcPoints } from '../math/curves';
import { add, cross, distance, dot, normalize, perp, scale, sub, type Vec2 } from '../math/vec';

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

/** Round the corners of a tangent polygon with a common radius. */
function fillet(vertices: Vec2[], minRadius: number): Vec2[] | undefined {
  const headings = vertices.slice(1).map((p, i) => normalize(sub(p, vertices[i]!)));
  const trims = vertices.map((_, i) => {
    if (i === 0 || i === vertices.length - 1) return 0;
    const cosine = dot(headings[i - 1]!, headings[i]!);
    return Math.sqrt((1 - cosine) / (1 + cosine));
  });
  let radius = END_TURN_RADIUS;
  for (let i = 0; i < headings.length; i++) {
    const lead = i === 0 || i === headings.length - 1 ? LEAD : 0;
    radius = Math.min(radius, (distance(vertices[i]!, vertices[i + 1]!) - lead) / (trims[i]! + trims[i + 1]!));
  }
  if (!(radius >= minRadius)) return undefined;
  const points = [vertices[0]!];
  for (let i = 1; i < vertices.length - 1; i++) {
    const incoming = headings[i - 1]!;
    const outgoing = headings[i]!;
    const setback = radius * trims[i]!;
    const entry = sub(vertices[i]!, scale(incoming, setback));
    const exit = add(vertices[i]!, scale(outgoing, setback));
    const sweep = Math.atan2(cross(incoming, outgoing), dot(incoming, outgoing));
    const center = add(entry, scale(perp(incoming), Math.sign(sweep) * radius));
    const angle = Math.atan2(entry.y - center.y, entry.x - center.x);
    line(points, entry);
    points.push(...arcPoints(center, radius, angle, angle + sweep, STEP).slice(1, -1), exit);
  }
  line(points, vertices[vertices.length - 1]!);
  return points;
}

function offsetBend(start: Vec2, end: Vec2, heading: Vec2, minRadius: number): Vec2[] | undefined {
  const entry = add(start, scale(heading, LEAD));
  const exit = sub(end, scale(heading, LEAD));
  const span = sub(exit, entry);
  const lateral = cross(heading, span);
  const radius = dot(span, span) / (4 * Math.abs(lateral));
  if (radius < minRadius) return undefined;
  const center = add(entry, scale(perp(heading), Math.sign(lateral) * radius));
  const angle = Math.atan2(entry.y - center.y, entry.x - center.x);
  const sweep = 2 * Math.atan2(Math.abs(lateral), dot(heading, span)) * Math.sign(lateral);
  const first = arcPoints(center, radius, angle, angle + sweep, STEP);
  first[0] = entry;
  const sum = add(start, end);
  return [start, ...first, ...first.slice(0, -1).reverse().map((p) => sub(sum, p)), end];
}

export function roundedEndConnection(start: Vec2, end: Vec2, incoming: Vec2, outgoing: Vec2, minRadius: number): Vec2[] | undefined {
  const delta = sub(end, start);
  const alignment = dot(incoming, outgoing);
  if (Math.abs(alignment) < Math.sin(5 * Math.PI / 180)) {
    const divisor = cross(incoming, outgoing);
    const before = cross(delta, outgoing) / divisor;
    const after = cross(incoming, delta) / divisor;
    if (before <= 0 || after <= 0) return undefined;
    return fillet([start, add(start, scale(incoming, before)), end], minRadius);
  }
  if (Math.abs(alignment) < Math.cos(5 * Math.PI / 180)) return undefined;
  const uTurn = alignment < 0;
  const axis = normalize(add(incoming, scale(outgoing, uTurn ? -1 : 1)));
  const advance = dot(delta, axis);
  const separation = Math.abs(cross(axis, delta));
  if (separation < 2 * minRadius || (!uTurn && advance > separation)) return undefined;
  const station = uTurn ? Math.max(0, advance) + END_TURN_RUN : advance / 2;
  const before = station / dot(incoming, axis);
  const after = (advance - station) / dot(outgoing, axis);
  if (before > 0 && after > 0) {
    const path = fillet([start, add(start, scale(incoming, before)), sub(end, scale(outgoing, after)), end], minRadius);
    if (path) return path;
  }
  if (!uTurn && advance >= -1e-8 && Math.abs(cross(incoming, outgoing)) < 1e-8) {
    return offsetBend(start, end, incoming, minRadius);
  }
  return undefined;
}
