import * as THREE from 'three';
import type { Vec2 } from '../sim/math/vec';
import type { Bounds } from '../sim/scenarios/types';

const MIN_MPP = 0.04;
const MAX_MPP = 3;

/**
 * Top-down orthographic map camera. World x = east, y = north;
 * Three.js space is (x, up, -y). Drag to pan, wheel to zoom about the cursor.
 */
export class MapCamera {
  readonly camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 1, 2000);
  centerX = 0;
  centerY = 0;
  /** Meters per CSS pixel. */
  mpp = 1;
  private width = 1;
  private height = 1;
  private dragging: { id: number; x: number; y: number } | null = null;
  private readonly abort = new AbortController();

  constructor(private readonly el: HTMLElement, private readonly canPan: (event: PointerEvent) => boolean) {
    this.camera.up.set(0, 0, -1);
    const signal = this.abort.signal;
    el.addEventListener('pointerdown', this.onPointerDown, { signal });
    el.addEventListener('pointermove', this.onPointerMove, { signal });
    el.addEventListener('pointerup', this.onPointerUp, { signal });
    el.addEventListener('pointercancel', this.onPointerUp, { signal });
    el.addEventListener('wheel', this.onWheel, { signal, passive: false });
    el.addEventListener('contextmenu', (e) => e.preventDefault(), { signal });
  }

  resize(width: number, height: number): void {
    this.width = Math.max(width, 1);
    this.height = Math.max(height, 1);
  }

  fit(b: Bounds, margin = 0.95): void {
    this.centerX = (b.minX + b.maxX) / 2;
    this.centerY = (b.minY + b.maxY) / 2;
    this.mpp = Math.max((b.maxX - b.minX) / this.width, (b.maxY - b.minY) / this.height) * margin;
  }

  update(): void {
    const hw = (this.width * this.mpp) / 2;
    const hh = (this.height * this.mpp) / 2;
    const c = this.camera;
    c.left = -hw;
    c.right = hw;
    c.top = hh;
    c.bottom = -hh;
    c.position.set(this.centerX, 1000, -this.centerY);
    c.lookAt(this.centerX, 0, -this.centerY);
    c.updateProjectionMatrix();
  }

  screenToWorld(px: number, py: number): { x: number; y: number } {
    return {
      x: this.centerX + (px - this.width / 2) * this.mpp,
      y: this.centerY - (py - this.height / 2) * this.mpp,
    };
  }

  worldToScreen(p: Vec2): Vec2 {
    return { x: this.width / 2 + (p.x - this.centerX) / this.mpp, y: this.height / 2 - (p.y - this.centerY) / this.mpp };
  }

  screenBounds(b: Bounds): DOMRect {
    const origin = this.worldToScreen({ x: b.minX, y: b.maxY });
    return new DOMRect(
      origin.x, origin.y,
      (b.maxX - b.minX) / this.mpp,
      (b.maxY - b.minY) / this.mpp,
    );
  }

  /** Pan just enough to show the outlined parcel in the clear part of the map. */
  reveal(b: Bounds, area: DOMRect): void {
    if (area.width <= 0 || area.height <= 0) return;
    this.mpp = Math.max(this.mpp, (b.maxX - b.minX) / area.width, (b.maxY - b.minY) / area.height);
    const rect = this.screenBounds(b);
    const x = Math.max(area.left, Math.min(rect.left, area.right - rect.width));
    const y = Math.max(area.top, Math.min(rect.top, area.bottom - rect.height));
    this.centerX += (rect.left - x) * this.mpp;
    this.centerY -= (rect.top - y) * this.mpp;
  }

  dispose(): void {
    this.abort.abort();
  }

  private readonly onPointerDown = (e: PointerEvent): void => {
    if (this.dragging || !e.isPrimary || !this.canPan(e)) return;
    this.dragging = { id: e.pointerId, x: e.clientX, y: e.clientY };
    this.el.setPointerCapture(e.pointerId);
  };

  private readonly onPointerMove = (e: PointerEvent): void => {
    if (!this.dragging || this.dragging.id !== e.pointerId) return;
    this.centerX -= (e.clientX - this.dragging.x) * this.mpp;
    this.centerY += (e.clientY - this.dragging.y) * this.mpp;
    this.dragging.x = e.clientX;
    this.dragging.y = e.clientY;
  };

  private readonly onPointerUp = (e: PointerEvent): void => {
    if (this.dragging?.id === e.pointerId) this.dragging = null;
  };

  private readonly onWheel = (e: WheelEvent): void => {
    e.preventDefault();
    const rect = this.el.getBoundingClientRect();
    const px = e.clientX - rect.left;
    const py = e.clientY - rect.top;
    const before = this.screenToWorld(px, py);
    this.mpp = THREE.MathUtils.clamp(this.mpp * Math.exp(e.deltaY * 0.0015), MIN_MPP, MAX_MPP);
    const after = this.screenToWorld(px, py);
    this.centerX += before.x - after.x;
    this.centerY += before.y - after.y;
  };
}
