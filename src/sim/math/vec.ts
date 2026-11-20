/** 2D vectors in world meters: x = east, y = north. */
export interface Vec2 {
  x: number;
  y: number;
}

export const vec2 = (x: number, y: number): Vec2 => ({ x, y });
export const add = (a: Vec2, b: Vec2): Vec2 => ({ x: a.x + b.x, y: a.y + b.y });
export const sub = (a: Vec2, b: Vec2): Vec2 => ({ x: a.x - b.x, y: a.y - b.y });
export const scale = (a: Vec2, k: number): Vec2 => ({ x: a.x * k, y: a.y * k });
export const cross = (a: Vec2, b: Vec2): number => a.x * b.y - a.y * b.x;
export const dot = (a: Vec2, b: Vec2): number => a.x * b.x + a.y * b.y;
export const length = (a: Vec2): number => Math.sqrt(a.x * a.x + a.y * a.y);
export const distance = (a: Vec2, b: Vec2): number => length(sub(a, b));

export const normalize = (a: Vec2): Vec2 => {
  const l = length(a);
  return l > 0 ? { x: a.x / l, y: a.y / l } : { x: 0, y: 0 };
};

/** Rotate 90° counter-clockwise: the left-hand normal of a direction. */
export const perp = (a: Vec2): Vec2 => ({ x: -a.y, y: a.x });

export const fromAngle = (radians: number): Vec2 => ({ x: Math.cos(radians), y: Math.sin(radians) });

export function projectOntoSegment(p: Vec2, a: Vec2, b: Vec2): Vec2 {
  const delta = sub(b, a);
  const squared = dot(delta, delta);
  if (squared === 0) return a;
  const t = Math.max(0, Math.min(1, dot(sub(p, a), delta) / squared));
  return add(a, scale(delta, t));
}
