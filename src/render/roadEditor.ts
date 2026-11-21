import { parkFootprint } from '../sim/town/parks';
import { edgeOffset, ROAD_TYPES, type RoadType } from '../sim/network/roadTypes';
import { BUDGET } from '../sim/town/economy';
import { editCost, shortage } from '../sim/town/budget';
import * as THREE from 'three';
import { offsetPolyline, polyline, slicePolyline, type Polyline } from '../sim/math/polyline';
import { add, scale, distance, dot, projectOntoSegment, type Vec2 } from '../sim/math/vec';
import { MEADOW_BUILD_BOUNDS, MEADOW_ROAD_WIDTH, planWalk, meadowScenario, meadowLayout, meadowNetwork, meadowRoadSections, upgradeFailure, snapToMeadowStreet, planMeadowRoad, isZoneStroke, type MeadowEdit } from '../sim/scenarios/meadow';
import { angleGuide, crossingAngleGuide, fitGuideToStreet, squareStreetGuide, type StreetPoint, type AngleGuide } from '../sim/network/angleSnap';
import { JUNCTION_MOUTH } from '../sim/network/streets';
import { cellsAlong, type CellKey, type ZoneCells } from '../sim/zoning/cells';
import { planZoneStroke, type LandUse, type Zoning } from '../sim/zoning/paint';
import type { ToWorker } from '../worker/protocol';
import type { MapCamera } from './camera';
import { disposeLayer } from './dispose';
import { FlatMesh } from './flat';
import { PALETTE } from './palette';
import { buildRoads } from './roads';
import { buildStrokePreview } from './zones';

export type MapTool = 'road' | 'curve' | 'upgrade' | 'bulldoze' | 'zone' | 'parking' | 'park' | 'pan' | 'footpath' | 'zebra';
export interface EditorState {
  tool: MapTool;
  roadType: RoadType;
  roadCount: number;
  connected: boolean;
  hint: string;
  pending: boolean;
  canCancel: boolean;
  cost: number | null;
  canUndo: boolean;
  angleSnapping: boolean;
  chaining: boolean;
  brush: LandUse | null;
  lotColumns: number;
  zoned: number;
}

export interface MeadowView {
  readonly edits: readonly MeadowEdit[];
  readonly cells: ZoneCells;
  readonly zoning: Zoning;
}

const CHAIN_HINT = 'Click to place the next point. Click the last point or press Esc to finish.';
const HOUSE_HINT = 'Click to see who lives here.';
const plots = (n: number): string => `${n} ${n === 1 ? 'plot' : 'plots'}`;
/** A press that moves further than this (px) is a drag, not a click. */
const CLICK_SLOP = 6;

/** Houses the player can click to inspect. */
export interface HousePicker {
  houseAt(p: Vec2): number | null;
  select(house: number | null): void;
}

type EditPhase =
  | { kind: 'idle' }
  | { kind: 'drawing'; id: number; host: StreetPoint | undefined; start: Vec2; press: Vec2; pointer: PointerEvent }
  | { kind: 'walk'; id: number; start: Vec2; network: ReturnType<typeof meadowNetwork>; tool: 'footpath' | 'zebra' }
  | { kind: 'editingSegment'; id: number; segment: number; press: Vec2 }
  /** A press on a house (or, with the pan tool, on open ground) that selects it if released in place. */
  | { kind: 'selecting'; id: number; house: number | null; press: Vec2 }
  | { kind: 'bending'; start: Vec2; end: Vec2; id: number | null }
  | { kind: 'painting'; id: number; zone: LandUse | null; touched: Set<CellKey>; lastPointer: Vec2 }
  | { kind: 'chaining'; host: StreetPoint | undefined; start: Vec2; id: number | null }
  | { kind: 'pending'; chain?: { from: Vec2; to: Vec2 } }
  | { kind: 'waiting' };

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
  private roadType: RoadType = 'town';
  private balance: number = BUDGET.startingBalance;

  setBalance(balance: number): void {
    if (balance === this.balance) return;
    this.balance = balance;
    if (this.phase.kind !== 'idle' || this.canvas.matches(':hover')) this.move ??= this.pointer;
  }

  private edits: readonly MeadowEdit[] = [];
  private cells: ZoneCells = { count: 0, keys: new Float64Array(), corners: new Float64Array() };
  private zoning: Zoning = new Map();
  private brush: LandUse | null = 'residential';
  private lotColumns = 1;
  private segmentTypes: readonly RoadType[] = [];
  private segments: readonly (readonly Vec2[])[] = [];
  private highlightedSegment: number | null = null;
  private roadCount = 0;
  private connected = false;
  private angleSnapping = true;
  private streets: Vec2[][] = [];
  private phase: EditPhase = { kind: 'pending' };
  private tool: MapTool = 'road';
  private hint = '';
  private readonly abort = new AbortController();
  private readonly handles = new THREE.Group();
  private readonly boundary = buildBoundary();
  private readonly hover = roadMarker();
  private cost: number | null = null;
  private preview: THREE.Group | null = null;
  private move: PointerEvent | null = null;
  private pointer: PointerEvent | null = null;

  constructor(
    private readonly canvas: HTMLCanvasElement,
    private readonly camera: MapCamera,
    private readonly scene: THREE.Scene,
    private readonly send: (msg: ToWorker) => void,
    private readonly setRoadVisibility: (visible: boolean) => void,
    private readonly houses: HousePicker,
  ) {
    const { signal } = this.abort;
    canvas.dataset.tool = this.tool;
    this.hover.visible = false;
    scene.add(this.handles, this.hover, this.boundary);
    canvas.addEventListener('pointerdown', (e) => this.begin(e), { signal });
    canvas.addEventListener('pointermove', (e) => {
      if (!e.isPrimary) return;
      this.move = e;
      this.pointer = e;
    }, { signal });
    canvas.addEventListener('pointerleave', () => {
      this.hover.visible = false;
      this.move = null;
      if ((this.tool === 'bulldoze' || this.tool === 'upgrade') && this.phase.kind === 'idle') this.highlight(null);
      if ((this.tool === 'zone' || this.tool === 'parking' || this.tool === 'park') && this.phase.kind === 'idle') this.previewStroke([], this.brush, '');
    }, { signal });
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
      tool: this.tool, roadType: this.roadType, cost: this.cost, hint: this.hint, roadCount: this.roadCount, connected: this.connected,
      angleSnapping: this.angleSnapping, chaining: kind === 'chaining',
      pending: kind === 'pending' || kind === 'waiting',
      canCancel: kind === 'bending' || kind === 'waiting',
      canUndo: this.edits.length > 0,
      brush: this.brush, lotColumns: this.lotColumns, zoned: this.zoning.size,
    };
  }

  canPan(e: PointerEvent): boolean {
    return this.phase.kind !== 'drawing' && this.phase.kind !== 'editingSegment' && this.phase.kind !== 'painting' && (this.tool === 'pan' || e.button !== 0);
  }

  setAngleSnapping(enabled: boolean): void {
    this.angleSnapping = enabled;
    if (this.phase.kind === 'drawing') this.move ??= this.phase.pointer;
    else if (this.phase.kind === 'chaining') this.move ??= this.pointer;
  }

  setTool(tool: MapTool): void {
    this.cancelDraft();
    this.tool = tool;
    this.canvas.dataset.tool = tool;
    this.handles.visible = tool === 'road' || tool === 'curve';
    this.boundary.visible = tool !== 'pan';
  }

  setRoadType(type: RoadType): void {
    this.roadType = type;
    this.highlightedSegment = null;
    this.move = this.pointer;
  }

  setLotColumns(columns: number): void {
    this.lotColumns = columns;
    this.move = this.pointer;
  }

  private parkingCells(cursor: Vec2): CellKey[] {
    const start = cellsAlong(this.cells, cursor, cursor)[0];
    if (start !== undefined && this.tool === 'park') return parkFootprint(start,this.lotColumns);
    return start === undefined ? [] : Array.from({ length: this.lotColumns }, (_, i) => (start + i * 8) as CellKey);
  }

  setBrush(brush: LandUse | null): void {
    this.cancelDraft();
    this.brush = brush;
    this.move ??= this.pointer;
  }

  accept({ edits, cells, zoning }: MeadowView): void {
    const chain = this.phase.kind === 'pending' ? this.phase.chain : undefined;
    const latest = edits.length > this.edits.length ? edits.at(-1) : undefined;
    this.edits = edits;
    this.cells = cells;
    this.zoning = zoning;
    this.roadCount = edits.filter((edit) => 'points' in edit).length;
    const layout = meadowLayout(edits);
    this.streets = layout.streets;
    this.segments = layout.segments;
    this.segmentTypes = layout.segmentTypes;
    this.connected = layout.connected;
    this.finish();
    if (latest && 'upgrade' in latest) this.hint = 'Changed segment to ' + ROAD_TYPES[latest.roadType].name + '.';
    else if (latest && 'remove' in latest) this.hint = 'Segment removed. Undo to restore it.';
    else if (latest && isZoneStroke(latest)) {
      this.hint = latest.zone === 'parking' ? 'Built a parking lot with ' + latest.cells.length * 2 + ' spaces.' : latest.zone ? `Zoned ${plots(latest.cells.length)} ${latest.zone}. Undo to remove them.` : `Cleared ${plots(latest.cells.length)}.`;
    }
    for (const handle of [...this.handles.children]) disposeLayer(handle);
    for (const tip of layout.tips) {
      const marker = roadMarker();
      marker.position.set(tip.x, 0, -tip.y);
      this.handles.add(marker);
    }
    const tip = chain && layout.tips.find((p) => distance(p, chain.to) < 1e-6);
    if (tip) {
      this.chain(tip);
      this.move = this.pointer;
    }
    this.update();
  }

  waitForTraffic(): void {
    this.phase = { kind: 'waiting' };
    this.hint = 'Waiting for traffic to clear. Keep the simulation running to finish this edit.';
  }

  reject(reason: string): void {
    const chain = this.phase.kind === 'pending' ? this.phase.chain : undefined;
    if (chain) this.chain(chain.from);
    else this.finish();
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
    if (this.state().pending || this.edits.length === 0) return;
    this.finish();
    this.phase = { kind: 'pending' };
    this.send({ type: 'undo' });
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

  private reach(): number {
    return Math.min(10, Math.max(3, 18 * this.camera.mpp));
  }

  private snap(p: Vec2, extraReach = 0): StreetPoint | undefined {
    return snapToMeadowStreet(this.streets, p, this.reach() + extraReach);
  }

  private segmentAt(cursor: Vec2): number | null {
    let reach = Infinity;
    let nearest: number | null = null;
    for (const [index, points] of this.segments.entries()) {
      for (let i = 1; i < points.length; i++) {
        const gap = distance(cursor, projectOntoSegment(cursor, points[i - 1]!, points[i]!));
        if (gap >= reach || gap > edgeOffset(this.segmentTypes[index]!, 'left') + Math.min(2, 4 * this.camera.mpp)) continue;
        nearest = index;
        reach = gap;
      }
    }
    return nearest;
  }

  private highlight(segment: number | null): void {
    if (segment === this.highlightedSegment) return;
    this.clearPreview();
    this.highlightedSegment = segment;
    this.hint = segment === null ? '' : 'Click to remove this segment.';
    if (segment !== null && this.tool === 'upgrade') {
      const reason = upgradeFailure(this.edits, segment, this.roadType);
      if (reason) {
        this.hint = reason;
        return;
      }
      const edit = { upgrade: segment, roadType: this.roadType };
      this.preview = buildRoads(meadowNetwork([...this.edits, edit]), 'dashed');
      this.scene.add(this.preview);
      this.setRoadVisibility(false);
      this.cost = editCost(this.edits, edit);
      this.hint = shortage(this.balance, this.cost) ?? 'Click to change this segment to ' + ROAD_TYPES[this.roadType].name + '.';
    } else if (segment !== null) this.guide(polyline(this.segments[segment]!), PALETTE.editorInvalid, MEADOW_ROAD_WIDTH);
  }

  private roadGuide(host: StreetPoint | undefined, start: Vec2, cursor: Vec2, snap: StreetPoint | undefined): AngleGuide | undefined {
    if (this.tool !== 'road' || !this.angleSnapping) return undefined;
    if (host?.kind === 'tip' || host?.kind === 'street') {
      const target = snap ?? this.snap(cursor, MEADOW_ROAD_WIDTH / 2);
      const square = target && squareStreetGuide(host, target);
      if (square) {
        const landing = snapToMeadowStreet(this.streets, square.end, 1e-6);
        if (landing?.kind === 'street' && landing.street === target.street
          && Math.abs(dot(landing.tangent, square.direction)) < 1e-6) return square;
      }
    }
    if (host?.kind === 'tip' && snap?.kind === 'tip') return undefined;
    let guide = host ? angleGuide(this.streets, host, cursor) : crossingAngleGuide(this.streets, start, cursor);
    if (guide && snap) {
      guide = fitGuideToStreet(guide, start, snap, Math.min(8, 14 * this.camera.mpp));
      if (guide && !host) {
        const { direction } = guide;
        const heading = dot(direction, snap.tangent);
        const straightArrival = snap.kind === 'street' ? Math.abs(heading) <= Math.SQRT1_2 + 1e-6
          : snap.kind === 'corner' ? snap.tangents.some((arm) => dot(direction, arm) > 1 - 1e-6)
          : heading < -1 + 1e-6;
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
    if (e.button !== 0 || !e.isPrimary) return;
    const press = { x: e.clientX, y: e.clientY };
    if (this.tool === 'pan') {
      // The camera pans on the same press; a drag cancels the selection.
      if (this.phase.kind === 'idle') this.phase = { kind: 'selecting', id: e.pointerId, house: this.houses.houseAt(this.world(e)), press };
      return;
    }
    this.move = null;
    if (this.phase.kind === 'bending' || this.phase.kind === 'chaining') {
      this.phase.id = e.pointerId;
      this.canvas.setPointerCapture(e.pointerId);
      this.point(e, false);
      return;
    }
    if (this.phase.kind !== 'idle') return;
    const cursor = this.world(e);
    if (this.tool === 'footpath' || this.tool === 'zebra') {
      this.phase = { kind: 'walk', tool: this.tool, start: cursor, network: meadowScenario(this.edits).network, id: e.pointerId };
      this.canvas.setPointerCapture(e.pointerId);
      this.point(e,false);
      return;
    }
    const house = this.clickableHouse(cursor);
    if (house !== null) {
      this.mark();
      this.phase = { kind: 'selecting', id: e.pointerId, house, press };
      this.canvas.setPointerCapture(e.pointerId);
      return;
    }
    if (this.tool === 'zone' || this.tool === 'parking' || this.tool === 'park') {
      const use = this.tool === 'park' || this.tool === 'parking' ? this.tool : this.brush;
      const touched = new Set(this.tool === 'parking' || this.tool === 'park' ? this.parkingCells(cursor) : cellsAlong(this.cells, cursor, cursor));
      this.phase = { kind: 'painting', id: e.pointerId, zone: use, touched, lastPointer: cursor };
      this.canvas.setPointerCapture(e.pointerId);
      this.previewStroke(touched, use, 'Release');
      return;
    }
    if (this.tool === 'bulldoze' || this.tool === 'upgrade') {
      const segment = this.segmentAt(cursor);
      this.highlight(segment);
      if (segment !== null) {
        this.phase = { kind: 'editingSegment', id: e.pointerId, segment, press: { x: e.clientX, y: e.clientY } };
        this.canvas.setPointerCapture(e.pointerId);
      }
      return;
    }
    const host = this.snap(cursor);
    if (!host && this.tool !== 'road') {
      this.hint = 'Start on a street or a marked road end.';
      return;
    }
    const start = host?.point ?? cursor;
    this.mark(start);
    this.phase = { kind: 'drawing', host, start, id: e.pointerId, pointer: e, press: { x: e.clientX, y: e.clientY } };
    this.hint = host ? 'Drag to the other end of your new road.' : 'Drag to lay a new road, or click to place it point by point.';
    this.canvas.setPointerCapture(e.pointerId);
  }

  /** A house under the cursor that a click selects rather than starting a road from a nearby street. */
  private clickableHouse(cursor: Vec2): number | null {
    if ((this.tool === 'bulldoze' || this.tool === 'upgrade') || this.tool === 'zone' || this.tool === 'parking' || this.tool === 'park') return null;
    const house = this.houses.houseAt(cursor);
    return house !== null && (this.tool === 'pan' || !this.snap(cursor)) ? house : null;
  }

  private point(e: PointerEvent, release: boolean): void {
    if (!e.isPrimary) return;
    if (release) this.move = null;
    const phase = this.phase;
    if (phase.kind === 'selecting') {
      if (phase.id !== e.pointerId) return;
      // Leave pointer capture alone: with the pan tool it belongs to the camera, and it ends on release anyway.
      const moved = Math.hypot(e.clientX - phase.press.x, e.clientY - phase.press.y) > CLICK_SLOP;
      if (moved || release) this.phase = { kind: 'idle' };
      if (!moved && release) this.houses.select(phase.house);
      return;
    }
    const cursor = this.world(e);
    if (phase.kind === 'idle') {
      const overHouse = this.clickableHouse(cursor) !== null;
      this.canvas.toggleAttribute('data-house', overHouse);
      if (overHouse) this.hint = HOUSE_HINT;
      else if (this.hint === HOUSE_HINT) this.hint = '';
    }
    if (this.tool === 'pan') return;
    if (phase.kind === 'walk') {
      if (phase.id !== e.pointerId) return;
      const plan = planWalk(phase.network,phase.tool,phase.start,cursor,{cells:this.cells,zoning:this.zoning});
      this.clearPreview();
      if (typeof plan === 'string') {
        if (release) this.finish();
        this.hint = plan;
        return;
      }
      this.cost = editCost(this.edits,plan);
      this.guide(polyline([plan.a,plan.b]),PALETTE.editorHandle,plan.walk === 'zebra' ? 3 : 1.8);
      this.hint = 'Release to build ' + (plan.walk === 'zebra' ? 'the zebra crossing.' : 'the footpath.');
      if (release) {
        this.finish();
        this.phase = { kind: 'pending' };
        this.send({type:'buildWalk',walk:phase.tool,start:phase.start,end:cursor});
      }
      return;
    }
    if (phase.kind === 'editingSegment') {
      if (phase.id !== e.pointerId) return;
      if (Math.hypot(e.clientX - phase.press.x, e.clientY - phase.press.y) > CLICK_SLOP || this.segmentAt(cursor) !== phase.segment) {
        this.finish();
      } else if (release) {
        this.phase = { kind: 'pending' };
        this.hint = this.tool === 'upgrade' ? 'Changing road type…' : 'Removing segment…';
        const target = { segment: phase.segment, editCount: this.edits.length };
        this.send(this.tool === 'upgrade' ? { type: 'upgradeRoad', roadType: this.roadType, ...target } : { type: 'bulldozeRoad', ...target });
      }
      return;
    }
    if (phase.kind === 'painting') {
      if (phase.id !== e.pointerId) return;
      if (phase.zone === 'parking' || phase.zone === 'park') {
        phase.touched = new Set(this.parkingCells(cursor));
      } else for (const key of cellsAlong(this.cells, phase.lastPointer, cursor)) phase.touched.add(key);
      phase.lastPointer = cursor;
      if (!release) {
        this.previewStroke(phase.touched, phase.zone, 'Release');
        return;
      }
      const plan = planZoneStroke(this.cells, this.zoning, phase.zone, [...phase.touched]);
      this.finish();
      if (!plan.ok) {
        this.hint = plan.reason;
        return;
      }
      const reason = shortage(this.balance, editCost(this.edits, plan.stroke));
      if (reason) {
        this.hint = reason;
        return;
      }
      this.phase = { kind: 'pending' };
      this.hint = phase.zone ? 'Zoning plots…' : 'Clearing plots…';
      this.send({ type: 'paintZone', zone: phase.zone, cells: [...phase.touched] });
      return;
    }
    if (phase.kind === 'idle') {
      if (this.tool === 'bulldoze' || this.tool === 'upgrade') this.highlight(this.segmentAt(cursor));
      else if (this.tool === 'park') this.previewStroke(this.parkingCells(cursor),'park','Click');
      else if (this.tool === 'parking') this.previewStroke(this.parkingCells(cursor), 'parking', 'Click');
      else if (this.tool === 'zone') this.previewStroke(cellsAlong(this.cells, cursor, cursor), this.brush, 'Click or drag');
      else this.mark(this.snap(cursor)?.point);
      return;
    }
    if (phase.kind === 'bending') {
      if (release && phase.id !== e.pointerId) return;
      this.place(phase.start, phase.end, cursor, release, 'Release or click to build this curve.');
      return;
    }
    if (phase.kind === 'chaining') {
      if (phase.id === null ? release : e.pointerId !== phase.id) return;
      if (distance(cursor, phase.start) <= this.reach()) {
        this.clearPreview();
        this.mark(phase.start);
        if (release) this.finish();
        else this.hint = CHAIN_HINT;
        return;
      }
    } else if (phase.kind === 'drawing' && e.pointerId === phase.id) {
      phase.pointer = e;
      if (Math.hypot(e.clientX - phase.press.x, e.clientY - phase.press.y) < 3) {
        this.clearPreview();
        if (release && this.tool === 'road') this.chain(phase.start);
        else if (release) this.finish();
        return;
      }
    } else return;
    const { host, start } = phase;
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
    const hint = phase.kind === 'chaining' ? CHAIN_HINT
      : this.tool === 'curve' ? 'Release to set the end, then place the bend.'
      : host?.kind === 'tip' && snap?.kind === 'tip' ? 'Release to connect the road ends.'
      : snap || joinedSide ? 'Release to connect the streets.' : 'Release to extend the street.';
    this.place(start, end, undefined, release, hint, guide);
  }

  private place(start: Vec2, end: Vec2, bend: Vec2 | undefined, release: boolean, hint: string, alignment?: AngleGuide): void {
    let plan = planMeadowRoad(this.edits, start, end, bend, this.roadType);
    const cost = plan.ok ? editCost(this.edits, plan.road) : 0;
    const reason = shortage(this.balance, cost);
    if (reason && plan.ok) plan = { ok: false, reason, points: plan.road.points };
    this.clearPreview();
    if (!plan.ok) {
      if (distance(start, end) > 0.1) {
        this.guide(polyline(plan.points ?? (bend ? [start, bend, end] : [start, end])), PALETTE.editorInvalid, plan.points ? MEADOW_ROAD_WIDTH : 0);
      }
      this.hint = !reason && !release && this.phase.kind === 'drawing' && this.tool === 'curve' ? hint : plan.reason;
    }
    if (release) {
      this.release(plan, start, end, bend);
      return;
    }
    if (!plan.ok) return;
    const fourWays = plan.road.fourWays ?? [];
    const placingBendEnd = this.tool === 'curve' && this.phase.kind === 'drawing';
    if (fourWays.length && !placingBendEnd) {
      const count = fourWays.length === 1 ? 'a four-way intersection' : `${fourWays.length} four-way intersections`;
      hint = `${this.phase.kind === 'chaining' ? 'Click' : 'Release'} to build ${count}.`;
    }
    this.cost = cost;
    this.hint = alignment ? `${alignment.label} · ${hint}` : hint;
    const preview = buildRoads(meadowNetwork([...this.edits, plan.road]), 'dashed');
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
      for (const side of [-1, 1]) edges.ribbon(offsetPolyline(visible, side * (edgeOffset(this.roadType, side > 0 ? 'left' : 'right') - 0.35)), 0.35);
    }
    preview.add(new THREE.Mesh(edges.build(), new THREE.MeshBasicMaterial({ color: PALETTE.editorHandle })));
    if (alignment) this.drawAngle(preview, start, alignment);
    this.setRoadVisibility(false);
    this.scene.add(preview);
    this.preview = preview;
  }

  private release(plan: ReturnType<typeof planMeadowRoad>, start: Vec2, end: Vec2, bend: Vec2 | undefined): void {
    const phase = this.phase;
    if (plan.ok) {
      this.finish();
      this.phase = phase.kind === 'chaining' ? { kind: 'pending', chain: { from: start, to: end } } : { kind: 'pending' };
      this.send({ type: 'buildRoad', roadType: this.roadType, start, end, bend });
    } else if (phase.kind === 'bending' || phase.kind === 'chaining') {
      phase.id = null;
    } else {
      this.finish();
      this.hint = plan.reason;
    }
  }

  private previewStroke(touched: Iterable<CellKey>, zone: LandUse | null, action: string): void {
    this.clearPreview();
    const keys = [...touched];
    if (keys.length === 0) {
      this.hint = '';
      return;
    }
    const plan = planZoneStroke(this.cells, this.zoning, zone, keys);
    if (!plan.ok) {
      this.hint = plan.reason;
      return;
    }
    const cost = editCost(this.edits, plan.stroke);
    const n = plots(plan.stroke.cells.length);
    this.hint = zone ? `${action} to zone ${n} ${zone}.` : `${action} to clear ${n}.`;
    if (zone === 'park') this.hint = action + ' to build a park · $' + plan.stroke.cells.length * BUDGET.parkUpkeep + '/day.';
    if (zone === 'parking') this.hint = action + ' to build ' + plan.stroke.cells.length * 2 + ' spaces · $' + plan.stroke.cells.length * 2 * BUDGET.upkeepPerBay + '/day.';
    const reason = shortage(this.balance, cost);
    if (reason) this.hint = reason;
    else this.cost = cost;
    this.preview = buildStrokePreview(this.cells, plan.stroke);
    this.scene.add(this.preview);
  }

  private chain(start: Vec2): void {
    this.finish();
    this.phase = { kind: 'chaining', host: snapToMeadowStreet(this.streets, start, 1e-6), start, id: null };
    this.hint = CHAIN_HINT;
  }

  private drawAngle(preview: THREE.Group, roadStart: Vec2, guide: AngleGuide): void {
    const start = guide.origin;
    const size = Math.min(distance(roadStart, guide.end) / 3, Math.max(MEADOW_ROAD_WIDTH / 2 + 8 * this.camera.mpp, 16 * this.camera.mpp));
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
    this.cost = null;
    if (this.preview) disposeLayer(this.preview);
    this.preview = null;
    this.highlightedSegment = null;
    this.setRoadVisibility(true);
  }

  private cancelPointer(e: PointerEvent): void {
    const phase = this.phase;
    if ('id' in phase && phase.id === e.pointerId) this.cancelDraft();
  }

  private cancelDraft(): void {
    if (this.phase.kind === 'pending') this.phase = { kind: 'pending' };
    else if (this.phase.kind !== 'waiting') this.finish();
  }

  private finish(): void {
    const phase = this.phase;
    this.phase = { kind: 'idle' };
    if ('id' in phase && phase.id !== null && this.canvas.hasPointerCapture(phase.id)) {
      this.canvas.releasePointerCapture(phase.id);
    }
    this.move = null;
    this.mark();
    this.hint = '';
    this.clearPreview();
  }
}
