import * as THREE from 'three';
import { offsetPolyline, polyline, slicePolyline, type Polyline } from '../sim/math/polyline';
import { add, scale, distance, dot, type Vec2 } from '../sim/math/vec';
import { MEADOW_BUILD_BOUNDS, MEADOW_ROAD_WIDTH, meadowConnected, meadowRoadSections, meadowScenario, snapToMeadowStreet, meadowStreets, meadowTips, planMeadowRoad, type MeadowRoad } from '../sim/scenarios/meadow';
import { angleGuide, crossingAngleGuide, fitGuideToStreet, squareStreetGuide, type StreetPoint, type AngleGuide } from '../sim/network/angleSnap';
import { JUNCTION_MOUTH } from '../sim/network/streets';
import type { ToWorker } from '../worker/protocol';
import type { MapCamera } from './camera';
import { disposeLayer } from './dispose';
import { FlatMesh } from './flat';
import { PALETTE } from './palette';
import { buildRoads } from './roads';

export type MapTool = 'road' | 'curve' | 'pan';
export interface EditorState {
  tool: MapTool;
  roadCount: number;
  connected: boolean;
  hint: string;
  pending: boolean;
  canCancel: boolean;
  angleSnapping: boolean;
}

type EditPhase =
  | { kind: 'idle' }
  | { kind: 'drawing'; id: number; host: StreetPoint | undefined; start: Vec2; press: Vec2; pointer: PointerEvent }
  | { kind: 'bending'; start: Vec2; end: Vec2; id: number | null }
  | { kind: 'pending' | 'waiting' };

function roadMarker(): THREE.Group {
  const marker = new THREE.Group();
  for (const [inner, outer, color] of [
    [0, 1, PALETTE.editorPaper],
    [0.73, 0.91, PALETTE.editorHandle],
    [0, 0.28, PALETTE.editorHandle],
  ] as const) {
    const mesh = new THREE.Mesh(
      new THREE.RingGeometry(inner, outer, 48).rotateX(-Math.PI / 2),
      new THREE.MeshBasicMaterial({ color }),
    );
    mesh.position.y = inner === 0 && outer === 1 ? 0.7 : 0.8;
    marker.add(mesh);
  }
  return marker;
}

function buildBoundary(): THREE.Mesh {
  const { minX, maxX, minY, maxY } = MEADOW_BUILD_BOUNDS;
  const curb = MEADOW_ROAD_WIDTH / 2;
  const corners = [
    { x: minX - curb, y: minY - curb }, { x: maxX + curb, y: minY - curb },
    { x: maxX + curb, y: maxY + curb }, { x: minX - curb, y: maxY + curb },
  ];
  const dashes = new FlatMesh(0.025);
  for (const [i, corner] of corners.entries()) {
    dashes.dashes(polyline([corner, corners[(i + 1) % corners.length]!]), 0.35, 2, 4);
  }
  return new THREE.Mesh(dashes.build(), new THREE.MeshBasicMaterial({ color: PALETTE.buildBoundary }));
}

export class RoadEditor {
  private roads: readonly MeadowRoad[] = [];
  private connected = false;
  private angleSnapping = true;
  private streets: Vec2[][] = [];
  private phase: EditPhase = { kind: 'pending' };
  private tool: MapTool = 'road';
  private hint = '';
  private width = MEADOW_ROAD_WIDTH;
  private readonly abort = new AbortController();
  private readonly handles = new THREE.Group();
  private readonly boundary = buildBoundary();
  private readonly hover = roadMarker();
  private preview: THREE.Group | null = null;
  private move: PointerEvent | null = null;

  constructor(
    private readonly canvas: HTMLCanvasElement,
    private readonly camera: MapCamera,
    private readonly scene: THREE.Scene,
    private readonly send: (msg: ToWorker) => void,
    private readonly setRoadVisibility: (visible: boolean) => void,
  ) {
    const { signal } = this.abort;
    canvas.dataset.tool = this.tool;
    this.hover.visible = false;
    scene.add(this.handles, this.hover, this.boundary);
    canvas.addEventListener('pointerdown', (e) => this.begin(e), { signal });
    canvas.addEventListener('pointermove', (e) => { if (e.isPrimary) this.move = e; }, { signal });
    canvas.addEventListener('pointerleave', () => { this.hover.visible = false; this.move = null; }, { signal });
    canvas.addEventListener('pointerup', (e) => this.point(e, true), { signal });
    canvas.addEventListener('lostpointercapture', (e) => this.cancelPointer(e), { signal });
    canvas.addEventListener('pointercancel', (e) => this.cancelPointer(e), { signal });
    window.addEventListener('blur', () => this.cancelDraft(), { signal });
    window.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') this.cancel();
    }, { signal });
  }

  state(): EditorState {
    const kind = this.phase.kind;
    return {
      tool: this.tool, hint: this.hint, roadCount: this.roads.length, connected: this.connected,
      angleSnapping: this.angleSnapping,
      pending: kind === 'pending' || kind === 'waiting',
      canCancel: kind === 'bending' || kind === 'waiting',
    };
  }

  canPan(e: PointerEvent): boolean {
    return this.phase.kind !== 'drawing' && (this.tool === 'pan' || e.button !== 0);
  }

  setAngleSnapping(enabled: boolean): void {
    this.angleSnapping = enabled;
    if (this.phase.kind === 'drawing') this.move ??= this.phase.pointer;
  }

  setTool(tool: MapTool): void {
    this.cancelDraft();
    this.tool = tool;
    this.canvas.dataset.tool = tool;
    this.handles.visible = tool !== 'pan';
    this.boundary.visible = tool !== 'pan';
  }

  accept(roads: readonly MeadowRoad[], width: number): void {
    this.roads = roads;
    this.streets = meadowStreets(roads);
    this.width = width;
    this.connected = meadowConnected(roads);
    this.finish();
    for (const handle of [...this.handles.children]) disposeLayer(handle);
    for (const tip of meadowTips(roads)) {
      const marker = roadMarker();
      marker.position.set(tip.x, 0, -tip.y);
      this.handles.add(marker);
    }
    this.update();
  }

  waitForTraffic(): void {
    this.phase = { kind: 'waiting' };
    this.hint = 'Waiting for traffic to clear. Keep the simulation running to finish this edit.';
  }

  reject(reason: string): void {
    this.finish();
    this.hint = reason;
  }

  update(): void {
    if (this.move) {
      const e = this.move;
      this.move = null;
      this.point(e, false);
    }
    const radius = this.camera.mpp * 10;
    for (const handle of this.handles.children) handle.scale.set(radius, 1, radius);
    this.hover.scale.set(radius, 1, radius);
  }

  undo(): void {
    if (this.state().pending || this.roads.length === 0) return;
    this.finish();
    this.phase = { kind: 'pending' };
    this.send({ type: 'undoRoad' });
  }

  cancel(): void {
    if (this.phase.kind === 'waiting') this.send({ type: 'cancelRoadEdit' });
    else this.cancelDraft();
  }

  dispose(): void {
    this.abort.abort();
    this.finish();
    disposeLayer(this.handles);
    disposeLayer(this.hover);
    disposeLayer(this.boundary);
  }

  private world(e: PointerEvent): Vec2 {
    const bounds = this.canvas.getBoundingClientRect();
    return this.camera.screenToWorld(e.clientX - bounds.left, e.clientY - bounds.top);
  }

  private snap(p: Vec2, extraReach = 0): StreetPoint | undefined {
    return snapToMeadowStreet(this.streets, p, Math.min(10, Math.max(3, 18 * this.camera.mpp)) + extraReach);
  }

  private roadGuide(host: StreetPoint | undefined, start: Vec2, cursor: Vec2, snap: StreetPoint | undefined): AngleGuide | undefined {
    if (this.tool !== 'road' || !this.angleSnapping) return undefined;
    if (host && host.kind !== 'junction') {
      const target = snap ?? this.snap(cursor, this.width / 2);
      const square = target && squareStreetGuide(host, target);
      if (square) {
        const landing = snapToMeadowStreet(this.streets, square.end, 1e-6);
        if (landing?.kind === 'street' && landing.street === target.street
          && Math.abs(dot(landing.tangent, square.direction)) < 1e-6) return square;
      }
    }
    let guide = host ? angleGuide(this.streets, host, cursor) : crossingAngleGuide(this.streets, start, cursor);
    if (guide && snap) {
      guide = fitGuideToStreet(guide, start, snap, Math.min(8, 14 * this.camera.mpp));
      if (guide && !host) {
        const heading = dot(guide.direction, snap.tangent);
        const straightArrival = snap.kind === 'street' ? Math.abs(heading) <= Math.SQRT1_2 + 1e-6 : heading < -1 + 1e-6;
        if (!straightArrival) guide = undefined;
      }
      if (guide && !snapToMeadowStreet(this.streets, guide.end, 1e-6)) guide = undefined;
    }
    return guide;
  }

  private mark(p?: Vec2): void {
    this.hover.visible = p !== undefined;
    if (p) this.hover.position.set(p.x, 0.02, -p.y);
  }

  private begin(e: PointerEvent): void {
    if (e.button !== 0 || !e.isPrimary || this.tool === 'pan') return;
    this.move = null;
    if (this.phase.kind === 'bending') {
      this.phase.id = e.pointerId;
      this.canvas.setPointerCapture(e.pointerId);
      this.point(e, false);
      return;
    }
    if (this.phase.kind !== 'idle') return;
    const cursor = this.world(e);
    const host = this.snap(cursor);
    if (!host && this.tool !== 'road') {
      this.hint = 'Start on a street or a marked road end.';
      return;
    }
    const start = host?.point ?? cursor;
    this.mark(start);
    this.phase = { kind: 'drawing', host, start, id: e.pointerId, pointer: e, press: { x: e.clientX, y: e.clientY } };
    this.hint = host ? 'Drag to the other end of your new road.' : 'Drag across an existing street to build a crossing.';
    this.canvas.setPointerCapture(e.pointerId);
  }

  private point(e: PointerEvent, release: boolean): void {
    if (!e.isPrimary || this.tool === 'pan') return;
    if (release) this.move = null;
    const phase = this.phase;
    const cursor = this.world(e);
    if (phase.kind === 'idle') {
      this.mark(this.snap(cursor)?.point);
      return;
    }
    if (phase.kind === 'bending') {
      if (release && phase.id !== e.pointerId) return;
      this.place(phase.start, phase.end, cursor, release, 'Release or click to build this curve.');
      return;
    }
    if (phase.kind !== 'drawing' || e.pointerId !== phase.id) return;
    phase.pointer = e;
    const { host, press, start } = phase;
    if (Math.hypot(e.clientX - press.x, e.clientY - press.y) < 3) {
      this.clearPreview();
      if (release) this.finish();
      return;
    }
    const snap = this.snap(cursor);
    const guide = this.roadGuide(host, start, cursor, snap);
    const end = guide?.end ?? snap?.point ?? cursor;
    this.mark(guide?.end ?? snap?.point);
    if (release && this.tool === 'curve' && distance(start, end) >= 2) {
      this.finish();
      this.phase = { kind: 'bending', start, end, id: null };
      this.mark(end);
      this.guide(polyline([start, end]), PALETTE.editorHandle);
      this.hint = 'Place a point on the bend. Click or tap to build.';
      return;
    }
    const joinedSide = guide?.label === '90° at both ends' || guide?.label === '90° at junction';
    const hint = this.tool === 'curve' ? 'Release to set the end, then place the bend.'
      : host?.kind === 'tip' && snap?.kind === 'tip' ? 'Release to connect the road ends.'
      : snap || joinedSide ? 'Release to connect the streets.' : 'Release to extend the street.';
    this.place(start, end, undefined, release, hint, guide);
  }

  private place(start: Vec2, end: Vec2, bend: Vec2 | undefined, release: boolean, hint: string, alignment?: AngleGuide): void {
    const plan = planMeadowRoad(this.roads, start, end, bend);
    this.clearPreview();
    if (!plan.ok) {
      if (release && this.phase.kind !== 'bending') this.finish();
      else if (distance(start, end) > 0.1) {
        this.guide(polyline(plan.points ?? (bend ? [start, bend, end] : [start, end])), PALETTE.editorInvalid, plan.points ? this.width : 0);
      }
      if (release && this.phase.kind === 'bending') this.phase.id = null;
      this.hint = !release && this.phase.kind === 'drawing' && this.tool === 'curve' ? hint : plan.reason;
      return;
    }
    if (release) {
      this.finish();
      this.phase = { kind: 'pending' };
      this.send({ type: 'buildRoad', start, end, bend });
      return;
    }
    const fourWays = plan.road.fourWays ?? [];
    const placingBendEnd = this.tool === 'curve' && this.phase.kind === 'drawing';
    if (fourWays.length && !placingBendEnd) {
      const count = fourWays.length === 1 ? 'a four-way intersection' : `${fourWays.length} four-way intersections`;
      hint = `Release to build ${count}.`;
    }
    this.hint = alignment ? `${alignment.label} · ${hint}` : hint;
    const preview = buildRoads(meadowScenario([...this.roads, plan.road]).network, 'dashed');
    const edges = new FlatMesh(0.19);
    const atJunction = (p: Vec2) => fourWays.some(({ point }) => distance(point, p) < 1e-6)
      || (alignment?.label === '90° at both ends' && (distance(p, start) < 1e-6 || distance(p, end) < 1e-6))
      || (alignment?.label === '90° at junction' && distance(p, end) < 1e-6);
    for (const points of meadowRoadSections(plan.road)) {
      const path = polyline(points);
      const from = atJunction(points[0]!) ? JUNCTION_MOUTH : 0;
      const to = path.length - (atJunction(points[points.length - 1]!) ? JUNCTION_MOUTH : 0);
      if (to <= from) continue;
      const visible = from > 0 || to < path.length ? slicePolyline(path, from, to) : path;
      for (const side of [-1, 1]) edges.ribbon(offsetPolyline(visible, side * (this.width / 2 - 0.35)), 0.35);
    }
    preview.add(new THREE.Mesh(edges.build(), new THREE.MeshBasicMaterial({ color: PALETTE.editorHandle })));
    if (alignment) this.drawAngle(preview, start, alignment);
    this.setRoadVisibility(false);
    this.scene.add(preview);
    this.preview = preview;
  }

  private drawAngle(preview: THREE.Group, roadStart: Vec2, guide: AngleGuide): void {
    const start = guide.origin;
    const size = Math.min(distance(roadStart, guide.end) / 3, Math.max(this.width / 2 + 8 * this.camera.mpp, 16 * this.camera.mpp));
    const marks = new FlatMesh(0.45);
    const width = Math.max(0.14, 1.7 * this.camera.mpp);
    const along = scale(guide.reference, size);
    const out = scale(guide.direction, size);
    if (guide.label === '90°' || guide.label === '90° at both ends' || guide.label === '90° at junction') {
      marks.ribbon(polyline([add(start, along), add(add(start, along), out), add(start, out)]), width);
      if (guide.label === '90° at both ends') {
        const inward = scale(out, -1);
        marks.ribbon(polyline([add(guide.end, along), add(add(guide.end, along), inward), add(guide.end, inward)]), width);
      }
    } else if (guide.label === '45°') {
      const arc = Array.from({ length: 9 }, (_, i) => {
        const direction = add(scale(guide.reference, 1 - i / 8), scale(guide.direction, i / 8));
        return add(start, scale(direction, size / Math.hypot(direction.x, direction.y)));
      });
      marks.ribbon(polyline(arc), width);
    } else {
      marks.ribbon(polyline([add(guide.origin, scale(along, -2)), add(guide.origin, scale(along, 2))]), width);
    }
    preview.add(new THREE.Mesh(marks.build(), new THREE.MeshBasicMaterial({ color: PALETTE.editorHandle })));
  }

  private guide(path: Polyline, color: string, pavementWidth = 0): void {
    const geometry = new FlatMesh(0.35);
    geometry.ribbon(path, Math.max(0.35, this.camera.mpp * 2));
    const group = new THREE.Group();
    if (pavementWidth) {
      const pavement = new FlatMesh(0.34);
      pavement.ribbon(path, pavementWidth);
      group.add(new THREE.Mesh(pavement.build(), new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.28 })));
    }
    group.add(new THREE.Mesh(geometry.build(), new THREE.MeshBasicMaterial({ color })));
    this.scene.add(group);
    this.preview = group;
  }

  private clearPreview(): void {
    if (this.preview) disposeLayer(this.preview);
    this.preview = null;
    this.setRoadVisibility(true);
  }

  private cancelPointer(e: PointerEvent): void {
    const phase = this.phase;
    if ((phase.kind === 'drawing' || phase.kind === 'bending') && phase.id === e.pointerId) this.cancelDraft();
  }

  private cancelDraft(): void {
    if (!this.state().pending) this.finish();
  }

  private finish(): void {
    const phase = this.phase;
    this.phase = { kind: 'idle' };
    if ((phase.kind === 'drawing' || phase.kind === 'bending') && phase.id !== null && this.canvas.hasPointerCapture(phase.id)) {
      this.canvas.releasePointerCapture(phase.id);
    }
    this.move = null;
    this.mark();
    this.hint = '';
    this.clearPreview();
  }
}
