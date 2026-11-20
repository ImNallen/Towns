import * as THREE from 'three';
import { offsetPolyline, polyline, type Polyline } from '../sim/math/polyline';
import { distance, type Vec2 } from '../sim/math/vec';
import { meadowConnected, meadowScenario, meadowSnap, meadowTips, planMeadowRoad, type MeadowRoad } from '../sim/scenarios/meadow';
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
}

type EditPhase =
  | { kind: 'idle' }
  | { kind: 'drawing'; id: number; start: Vec2; press: Vec2 }
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

export class RoadEditor {
  private roads: readonly MeadowRoad[] = [];
  private connected = false;
  private phase: EditPhase = { kind: 'pending' };
  private tool: MapTool = 'road';
  private hint = '';
  private width = 8;
  private readonly abort = new AbortController();
  private readonly handles = new THREE.Group();
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
    scene.add(this.handles, this.hover);
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
      pending: kind === 'pending' || kind === 'waiting',
      canCancel: kind === 'bending' || kind === 'waiting',
    };
  }

  canPan(e: PointerEvent): boolean {
    return this.phase.kind !== 'drawing' && (this.tool === 'pan' || e.button !== 0);
  }

  setTool(tool: MapTool): void {
    this.cancelDraft();
    this.tool = tool;
    this.canvas.dataset.tool = tool;
    this.handles.visible = tool !== 'pan';
  }

  accept(roads: readonly MeadowRoad[], width: number): void {
    this.roads = roads;
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
  }

  private world(e: PointerEvent): Vec2 {
    const bounds = this.canvas.getBoundingClientRect();
    return this.camera.screenToWorld(e.clientX - bounds.left, e.clientY - bounds.top);
  }

  private snap(p: Vec2): Vec2 | undefined {
    return meadowSnap(this.roads, p, Math.min(10, Math.max(3, 18 * this.camera.mpp)));
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
    const start = this.snap(this.world(e));
    if (!start) {
      this.hint = 'Start on a street or a marked road end.';
      return;
    }
    this.mark(start);
    this.phase = { kind: 'drawing', start, id: e.pointerId, press: { x: e.clientX, y: e.clientY } };
    this.hint = 'Drag to the other end of your new road.';
    this.canvas.setPointerCapture(e.pointerId);
  }

  private point(e: PointerEvent, release: boolean): void {
    if (!e.isPrimary || this.tool === 'pan') return;
    if (release) this.move = null;
    const phase = this.phase;
    const cursor = this.world(e);
    if (phase.kind === 'idle') {
      this.mark(this.snap(cursor));
      return;
    }
    if (phase.kind === 'bending') {
      if (release && phase.id !== e.pointerId) return;
      this.place(phase.start, phase.end, cursor, release, 'Release or click to build this curve.');
      return;
    }
    if (phase.kind !== 'drawing' || e.pointerId !== phase.id) return;
    const { start, press } = phase;
    if (Math.hypot(e.clientX - press.x, e.clientY - press.y) < 3) {
      this.clearPreview();
      if (release) this.finish();
      return;
    }
    const snap = this.snap(cursor);
    const end = snap ?? cursor;
    this.mark(snap);
    if (release && this.tool === 'curve' && distance(start, end) >= 2) {
      this.finish();
      this.phase = { kind: 'bending', start, end, id: null };
      this.mark(end);
      this.guide(polyline([start, end]), PALETTE.editorHandle);
      this.hint = 'Place a point on the bend. Click or tap to build.';
      return;
    }
    const hint = this.tool === 'curve' ? 'Release to set the end, then place the bend.'
      : snap ? 'Release to connect the streets.' : 'Release to extend the street.';
    this.place(start, end, undefined, release, hint);
  }

  private place(start: Vec2, end: Vec2, bend: Vec2 | undefined, release: boolean, hint: string): void {
    const plan = planMeadowRoad(this.roads, start, end, bend);
    this.clearPreview();
    if (!plan.ok) {
      if (release && this.phase.kind !== 'bending') this.finish();
      else if (distance(start, end) > 0.1) {
        this.guide(polyline(bend ? [start, bend, end] : [start, end]), PALETTE.editorInvalid);
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
    this.hint = hint;
    const preview = buildRoads(meadowScenario([...this.roads, plan.road]).network, 'dashed');
    const edges = new FlatMesh(0.19);
    for (const side of [-1, 1]) edges.ribbon(offsetPolyline(plan.path, side * (this.width / 2 - 0.35)), 0.35);
    preview.add(new THREE.Mesh(edges.build(), new THREE.MeshBasicMaterial({ color: PALETTE.editorHandle })));
    this.setRoadVisibility(false);
    this.scene.add(preview);
    this.preview = preview;
  }

  private guide(path: Polyline, color: string): void {
    const geometry = new FlatMesh(0.35);
    geometry.ribbon(path, Math.max(0.35, this.camera.mpp * 2));
    const group = new THREE.Group();
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
