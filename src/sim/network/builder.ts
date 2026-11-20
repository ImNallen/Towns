import { cubicPoints } from '../math/curves';
import { endOf, offsetPolyline, polyline, reversePolyline, startOf, type Polyline } from '../math/polyline';
import { distance } from '../math/vec';
import type { Lane, LaneKind, Network, Surface, SurfaceStyle } from './types';

/** Max gap allowed between the end of a lane and the start of a lane it connects to. */
const CONNECTION_TOLERANCE = 0.25;

export interface RoadOptions {
  width: number;
  laneWidth: number;
  speedLimit: number;
}

export class NetworkBuilder {
  private readonly lanes: Lane[] = [];
  private readonly surfaces: Surface[] = [];

  addLane(kind: LaneKind, path: Polyline, speedLimit: number): number {
    const id = this.lanes.length;
    this.lanes.push({ id, kind, path, length: path.length, speedLimit, next: [], prev: [], yieldTo: [] });
    return id;
  }

  lane(id: number): Lane {
    const lane = this.lanes[id];
    if (!lane) throw new Error(`unknown lane ${id}`);
    return lane;
  }

  connect(from: number, to: number): void {
    this.lane(from).next.push(to);
  }

  /** `lane` gives way to `priority` lanes where it merges. */
  giveWay(lane: number, priority: readonly number[]): void {
    this.lane(lane).yieldTo.push(...priority);
  }

  addSurface(style: SurfaceStyle, centerline: Polyline, width: number): number {
    const id = this.surfaces.length;
    this.surfaces.push({ id, style, centerline, width });
    return id;
  }

  /**
   * Two-way road with one lane each way (right-hand traffic).
   * `forward` runs along the centerline's direction, `backward` against it.
   */
  addTwoWayRoad(centerline: Polyline, opts: RoadOptions): { forward: number; backward: number } {
    const half = opts.laneWidth / 2;
    const forward = this.addLane('road', offsetPolyline(centerline, -half), opts.speedLimit);
    const backward = this.addLane('road', offsetPolyline(reversePolyline(centerline), -half), opts.speedLimit);
    this.addSurface('twoWay', centerline, opts.width);
    return { forward, backward };
  }

  /** Curved connector lane from the end of `from` to the start of `to`, plus its surface. */
  addConnector(from: number, to: number, speedLimit: number, surfaceWidth: number): number {
    const a = endOf(this.lane(from).path);
    const b = startOf(this.lane(to).path);
    const k = distance(a, b) * 0.4;
    const pts = cubicPoints(
      a,
      { x: a.x + a.hx * k, y: a.y + a.hy * k },
      { x: b.x - b.hx * k, y: b.y - b.hy * k },
      b,
    );
    const path = polyline(pts);
    const id = this.addLane('connector', path, speedLimit);
    this.connect(from, id);
    this.connect(id, to);
    this.addSurface('junction', path, surfaceWidth);
    return id;
  }

  build(): Network {
    for (const lane of this.lanes) {
      for (const n of lane.next) {
        const next = this.lane(n);
        next.prev.push(lane.id);
        const gap = distance(endOf(lane.path), startOf(next.path));
        if (gap > CONNECTION_TOLERANCE) {
          throw new Error(`lane ${lane.id} -> ${n} is disconnected by ${gap.toFixed(2)}m`);
        }
      }
    }
    for (const lane of this.lanes) {
      if (lane.yieldTo.length === 0) continue;
      if (lane.next.length !== 1) throw new Error(`yielding lane ${lane.id} must have exactly one next lane`);
      const target = lane.next[0]!;
      for (const p of lane.yieldTo) {
        if (!this.lane(p).next.includes(target)) {
          throw new Error(`priority lane ${p} does not feed merge target ${target} of lane ${lane.id}`);
        }
      }
    }
    return {
      lanes: this.lanes,
      surfaces: this.surfaces,
      sources: this.lanes.filter((l) => l.prev.length === 0).map((l) => l.id),
      sinks: this.lanes.filter((l) => l.next.length === 0).map((l) => l.id),
    };
  }
}
