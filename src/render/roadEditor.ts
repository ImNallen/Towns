import * as THREE from 'three';
import { polyline, type Polyline } from '../sim/math/polyline';
import { distance, type Vec2 } from '../sim/math/vec';
import { meadowTips, planMeadowRoad, type MeadowRoad } from '../sim/scenarios/meadow';
import type { ToWorker } from '../worker/protocol';
import type { MapCamera } from './camera';
import { disposeLayer } from './dispose';
import { FlatMesh } from './flat';
import { PALETTE } from './palette';

export type MapTool = 'road' | 'pan';
export interface EditorState {
  tool: MapTool;
  roadCount: number;
  connected: boolean;
  hint: string;
  pending: boolean;
}

type EditPhase =
  | { kind: 'idle' }
  | { kind: 'drawing'; id: number; start: Vec2; press: Vec2 }
  | { kind: 'pending' };

export class RoadEditor {
  private roads: readonly MeadowRoad[] = [];
  private tips: Vec2[] = [];
  private phase: EditPhase = { kind: 'pending' };
  private tool: MapTool = 'road';
  private hint = '';
  private width = 8;
  private readonly abort = new AbortController();
  private readonly handles = new THREE.Group();
  private preview: THREE.Group | null = null;

  constructor(
    private readonly canvas: HTMLCanvasElement,
    private readonly camera: MapCamera,
    private readonly scene: THREE.Scene,
    private readonly send: (msg: ToWorker) => void,
  ) {
    const { signal } = this.abort;
    canvas.dataset.tool = this.tool;
    scene.add(this.handles);
    canvas.addEventListener('pointerdown', (e) => this.begin(e), { signal });
    canvas.addEventListener('pointermove', (e) => this.draw(e, false), { signal });
    canvas.addEventListener('pointerup', (e) => this.draw(e, true), { signal });
    canvas.addEventListener('lostpointercapture', (e) => this.cancelPointer(e), { signal });
    canvas.addEventListener('pointercancel', (e) => this.cancelPointer(e), { signal });
    window.addEventListener('blur', () => this.cancel(), { signal });
    window.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') this.cancel();
    }, { signal });
  }

  state(): EditorState {
    return {
      tool: this.tool,
      hint: this.hint,
      roadCount: this.roads.length,
      connected: this.tips.length === 0 && this.roads.length > 0,
      pending: this.phase.kind === 'pending',
    };
  }

  canPan(e: PointerEvent): boolean {
    return this.phase.kind !== 'drawing' && (this.tool === 'pan' || e.button !== 0);
  }

  setTool(tool: MapTool): void {
    this.cancel();
    this.tool = tool;
    this.canvas.dataset.tool = tool;
    this.handles.visible = tool === 'road';
  }

  accept(roads: readonly MeadowRoad[], width: number): void {
    const wasConnected = this.roads.length > 0 && !this.tips.length;
    this.roads = roads;
    this.width = width;
    this.tips = meadowTips(roads);
    this.finish();
    if (!this.tips.length) this.setTool('pan');
    else if (wasConnected) this.setTool('road');
    for (const handle of [...this.handles.children]) disposeLayer(handle);
    for (const tip of this.tips) {
      const marker = new THREE.Group();
      const ring = (inner: number, outer: number, color: string, height: number): void => {
        const mesh = new THREE.Mesh(
          new THREE.RingGeometry(inner, outer, 48).rotateX(-Math.PI / 2),
          new THREE.MeshBasicMaterial({ color }),
        );
        mesh.position.y = height;
        marker.add(mesh);
      };
      ring(0, 1, PALETTE.editorPaper, 0.7);
      ring(0.73, 0.91, PALETTE.editorHandle, 0.8);
      ring(0, 0.28, PALETTE.editorHandle, 0.8);
      marker.position.set(tip.x, 0, -tip.y);
      this.handles.add(marker);
    }
    this.update();
  }

  reject(reason: string): void {
    this.finish();
    this.hint = reason;
  }

  update(): void {
    const radius = this.camera.mpp * 10;
    for (const handle of this.handles.children) handle.scale.set(radius, 1, radius);
  }

  undo(): void {
    if (this.phase.kind === 'pending' || this.roads.length === 0) return;
    this.cancel();
    this.phase = { kind: 'pending' };
    this.send({ type: 'undoRoad' });
  }

  dispose(): void {
    this.abort.abort();
    this.cancel();
    this.clearPreview();
    disposeLayer(this.handles);
  }

  private world(e: PointerEvent): Vec2 {
    const bounds = this.canvas.getBoundingClientRect();
    return this.camera.screenToWorld(e.clientX - bounds.left, e.clientY - bounds.top);
  }

  private nearestTip(p: Vec2, exclude?: Vec2): Vec2 | undefined {
    let best: Vec2 | undefined;
    let reach = Math.max(3, 22 * this.camera.mpp);
    for (const tip of this.tips) {
      const d = distance(p, tip);
      if (tip !== exclude && d <= reach) {
        best = tip;
        reach = d;
      }
    }
    return best;
  }

  private begin(e: PointerEvent): void {
    if (e.button !== 0 || !e.isPrimary || this.tool !== 'road' || this.phase.kind !== 'idle' || !this.tips.length) return;
    const start = this.nearestTip(this.world(e));
    if (!start) {
      this.hint = 'Start at a marked road end.';
      return;
    }
    this.phase = { kind: 'drawing', start, id: e.pointerId, press: { x: e.clientX, y: e.clientY } };
    this.hint = 'Drag to extend the street or join the other end.';
    this.canvas.setPointerCapture(e.pointerId);
  }

  private draw(e: PointerEvent, release: boolean): void {
    if (this.phase.kind !== 'drawing' || e.pointerId !== this.phase.id) return;
    const { start, press } = this.phase;
    if (Math.hypot(e.clientX - press.x, e.clientY - press.y) < 3) {
      this.clearPreview();
      if (release) this.finish();
      return;
    }
    const cursor = this.world(e);
    const snap = this.nearestTip(cursor, start);
    const end = snap ?? cursor;
    const plan = planMeadowRoad(this.roads, start, end);
    if (release) {
      this.finish();
      if (plan.ok) {
        this.phase = { kind: 'pending' };
        this.send({ type: 'buildRoad', start, end });
      } else {
        this.hint = plan.reason;
      }
      return;
    }
    this.clearPreview();
    if (!plan.ok) {
      this.hint = plan.reason;
      if (distance(start, end) > 0.1) this.showPreview(polyline([start, end]), false);
      return;
    }
    this.hint = snap ? 'Release to connect the streets.' : 'Release to extend the street.';
    this.showPreview(plan.path, true);
  }

  private showPreview(path: Polyline, valid: boolean): void {
    const group = new THREE.Group();
    const ribbon = (width: number, height: number, color: string): void => {
      const geometry = new FlatMesh(height);
      geometry.ribbon(path, width);
      group.add(new THREE.Mesh(geometry.build(), new THREE.MeshBasicMaterial({ color })));
    };
    if (valid) {
      ribbon(this.width + 0.9, 0.3, PALETTE.editorHandle);
      ribbon(this.width, 0.35, PALETTE.editorPreview);
      ribbon(0.3, 0.4, PALETTE.editorPaper);
    } else {
      ribbon(Math.max(0.35, this.camera.mpp * 2), 0.35, PALETTE.editorInvalid);
    }
    this.scene.add(group);
    this.preview = group;
  }

  private clearPreview(): void {
    if (this.preview) disposeLayer(this.preview);
    this.preview = null;
  }

  private cancelPointer(e: PointerEvent): void {
    if (this.phase.kind === 'drawing' && this.phase.id === e.pointerId) this.cancel();
  }

  private cancel(): void {
    if (this.phase.kind !== 'pending') this.finish();
  }

  private finish(): void {
    const phase = this.phase;
    this.phase = { kind: 'idle' };
    if (phase.kind === 'drawing' && this.canvas.hasPointerCapture(phase.id)) {
      this.canvas.releasePointerCapture(phase.id);
    }
    this.hint = '';
    this.clearPreview();
  }
}
