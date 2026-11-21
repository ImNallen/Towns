import { TrafficLayer } from './traffic';
import type { TrafficView } from '../sim/traffic/conditions';
import { WalkerLayer } from './walkers';
import type { RoadType } from '../sim/network/roadTypes';
import { SUN_DIRECTION, SUN_INTENSITY, AMBIENT_INTENSITY } from './lighting';
import * as THREE from 'three';
import type { Vec2 } from '../sim/math/vec';
import type { Network } from '../sim/network/types';
import type { ScenarioName } from '../sim/scenarios';
import { meadowZoning, type MeadowEdit } from '../sim/scenarios/meadow';
import type { TownView } from '../sim/town/town';
import type { SimStats } from '../sim/world';
import type { ZoneCells } from '../sim/zoning/cells';
import type { LandUse } from '../sim/zoning/paint';
import type { FromWorker, ToWorker } from '../worker/protocol';
import { MapCamera } from './camera';
import { buildLaneOverlay } from './debug';
import { disposeLayer } from './dispose';
import { RoadEditor, type EditorState, type MapTool } from './roadEditor';
import { buildDecor } from './decor';
import { HouseLayer } from './houses';
import { PALETTE } from './palette';
import { buildRoads } from './roads';
import { VehicleLayer } from './vehicles';
import { buildParkingView, buildZoneLayer, buildZonePaint } from './zones';

export interface GameOptions {
  walkLimit?: number;
  scenario: ScenarioName;
  seed: number;
  speed: number;
  showLanes: boolean;
  showZones: boolean;
  /** Optional initial view: centre (world meters) and meters per pixel. */
  view?: { x: number; y: number; mpp: number };
}

export interface Game {
  walkerPositions(): Float32Array;
  editor(): EditorState | null;
  setAngleSnapping(enabled: boolean): void;
  setActuated(value: boolean): void;
  setRoadType(type: RoadType): void;
  setTool(tool: MapTool): void;
  setLotColumns(columns: number): void;
  setBrush(brush: LandUse | null): void;
  undo(): void;
  cancelRoadEdit(): void;
  stats(): SimStats | null;
  /** Residents and the town clock; null on maps without a town. */
  town(): TownView | null;
  /** Index into `scenario.decor.houses` (= `HouseholdView.home`) of the inspected house. */
  selectedHouse(): number | null;
  selectedParcelOnScreen(): DOMRect | null;
  worldToScreen(point: Vec2): Vec2;
  revealSelectedParcel(area: DOMRect): void;
  selectHouse(house: number | null): void;
  fps(): number;
  speed(): number;
  setSpeed(speed: number): void;
  showLanes(): boolean;
  setTrafficView(show: boolean): void;
  traffic(): TrafficView | null;
  approachName(lane: number): string;
  setParkingView(show: boolean): void;
  setShowLanes(show: boolean): void;
  dispose(): void;
}

export function createGame(canvas: HTMLCanvasElement, options: GameOptions): Game {
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFShadowMap;

  const scene = new THREE.Scene();
  scene.background = new THREE.Color(PALETTE.ground);

  const ground = new THREE.Mesh(
    new THREE.PlaneGeometry(4000, 4000).rotateX(-Math.PI / 2),
    new THREE.MeshLambertMaterial({ color: PALETTE.ground }),
  );
  ground.receiveShadow = true;
  scene.add(ground);

  scene.add(new THREE.AmbientLight(0xffffff, AMBIENT_INTENSITY));
  const sun = new THREE.DirectionalLight(0xffffff, SUN_INTENSITY);
  sun.position.copy(SUN_DIRECTION).multiplyScalar(600);
  sun.castShadow = true;
  sun.shadow.mapSize.set(4096, 4096);
  sun.shadow.radius = 2;
  sun.shadow.bias = -0.0005;
  sun.shadow.normalBias = 0.2;
  Object.assign(sun.shadow.camera, { left: -650, right: 650, top: 650, bottom: -650, near: 1, far: 1400 });
  scene.add(sun, sun.target);

  let editor: RoadEditor | null = null;
  const mapCamera = new MapCamera(canvas, (event) => editor?.canPan(event) ?? true);
  let roadLayer: THREE.Group | null = null;
  let walkerPositions: Float32Array = new Float32Array();
  const walkerLayer = new WalkerLayer();
  scene.add(walkerLayer.group);
  let vehicles: VehicleLayer | null = null;
  let houses: HouseLayer | null = null;
  let trafficLayer: TrafficLayer | null = null;
  let traffic: TrafficView | null = null;
  let trafficVisible = false;
  let laneNames: string[] = [];
  let laneOverlay: THREE.Group | null = null;
  let zoneLayer: THREE.Group | null = null;
  let paintLayer: THREE.Group | null = null;
  let cells: ZoneCells | undefined;
  let showLanes = options.showLanes;
  let parkingLayer: THREE.Group | null = null;
  let occupancy = false;
  let parkingSignature = '';
  function drawParking(view: TownView) {
    const signature = JSON.stringify(view.bays) + occupancy;
    if (signature === parkingSignature) return;
    parkingSignature = signature;
    if (parkingLayer) disposeLayer(parkingLayer);
    parkingLayer = buildParkingView(view.bays, occupancy);
    scene.add(parkingLayer);
  }
  let speed = options.speed;
  let latestStats: SimStats | null = null;
  let latestTown: TownView | null = null;
  let selectedHouse: number | null = null;
  const selectHouse = (house: number | null): void => {
    selectedHouse = house;
    houses?.select(house);
  };

  const worker = new Worker(new URL('../worker/sim.worker.ts', import.meta.url), { type: 'module' });
  const send = (msg: ToWorker): void => worker.postMessage(msg);

  if (options.scenario === 'meadow') editor = new RoadEditor(canvas, mapCamera, scene, send, (visible) => {
    if (roadLayer) roadLayer.visible = visible;
  }, {
    houseAt: (p) => (latestTown ? houses?.houseAt(p) ?? null : null),
    select: selectHouse,
  });

  const drawNetwork = (network: Network): void => {
    if (roadLayer) disposeLayer(roadLayer);
    if (laneOverlay) disposeLayer(laneOverlay);
    if (trafficLayer) disposeLayer(trafficLayer.group);
    traffic = null;
    trafficLayer = new TrafficLayer(network);
    trafficLayer.group.visible = trafficVisible;
    scene.add(trafficLayer.group);
    laneNames = network.lanes.map(lane => {
      if (options.scenario === 'mill') return ['West approach', 'Mill Street', 'Works Road', 'Mill Street', 'North Road', 'East approach'][lane.id]!;
      const p = lane.path.pts;
      const x = p[p.length - 2]!, y = p[p.length - 1]!;
      return Math.abs(x) > Math.abs(y) ? (x < 0 ? 'West approach' : 'East approach') : (y < 0 ? 'South approach' : 'North approach');
    });
    roadLayer = buildRoads(network, editor ? 'dashed' : 'solid');
    laneOverlay = buildLaneOverlay(network);
    laneOverlay.visible = showLanes;
    scene.add(roadLayer, laneOverlay);
  };

  const gridVisible = (): boolean => options.showZones || editor?.state().tool === 'zone' || editor?.state().tool === 'parking' || editor?.state().tool === 'park';
  const drawZones = (): void => {
    if (zoneLayer) disposeLayer(zoneLayer);
    zoneLayer = cells ? buildZoneLayer(cells) : null;
    if (!zoneLayer) return;
    zoneLayer.visible = gridVisible();
    scene.add(zoneLayer);
  };
  const showEdits = (edits: readonly MeadowEdit[]): void => {
    if (!editor || !cells) return;
    const zoning = meadowZoning(edits, cells);
    if (paintLayer) disposeLayer(paintLayer);
    houses?.setPaint({ cells, zoning });
    if (latestTown) houses?.update(latestTown.households, latestTown.businesses);
    paintLayer = buildZonePaint(cells, zoning);
    scene.add(paintLayer);
    editor.accept({ edits, cells, zoning });
  };

  worker.onmessage = (e: MessageEvent<FromWorker>) => {
    const msg = e.data;
    if (msg.type === 'ready') {
      const { scenario } = msg;
      scene.add(buildDecor(scenario.decor));
      houses = new HouseLayer(scenario.decor.houses);
      scene.add(houses.group);
      drawNetwork(scenario.network);
      cells = scenario.zones;
      drawZones();
      showEdits([]);
      vehicles = new VehicleLayer(msg.capacity);
      scene.add(vehicles.mesh);
      if (options.view) {
        mapCamera.centerX = options.view.x;
        mapCamera.centerY = options.view.y;
        mapCamera.mpp = options.view.mpp;
      } else {
        mapCamera.fit(scenario.bounds);
      }
      ready = true;
    } else if (msg.type === 'roadsChanged') {
      drawNetwork(msg.network);
      cells = msg.zones;
      drawZones();
      showEdits(msg.edits);
    } else if (msg.type === 'zoningChanged') {
      showEdits(msg.edits);
    } else if (msg.type === 'editWaiting') {
      editor?.waitForTraffic();
    } else if (msg.type === 'editRejected') {
      editor?.reject(msg.reason);
    } else if (msg.type === 'town') {
      latestTown = msg.view;
      drawParking(msg.view);
      if (vehicles) { vehicles.businesses = msg.view.businesses; vehicles.bays = msg.view.bays; vehicles.overflowCars = msg.view.overflowCars; }
      editor?.setBalance(msg.view.budget.balance);
      houses?.update(msg.view.households, msg.view.businesses);
      if (selectedHouse !== null && !msg.view.households.some(h => h.home === selectedHouse)
        && !msg.view.businesses.some(b => b.home === selectedHouse)) selectHouse(null);
    } else if (msg.type === 'frame') {
      walkerPositions = msg.walkers;
      walkerLayer.update(walkerPositions);
      vehicles?.push(msg, performance.now());
      roadLayer?.userData.updateSignals(msg.stats.tick, msg.signalClocks);
      latestStats = msg.stats;
      traffic = msg.traffic;
      if (trafficVisible) trafficLayer?.update(traffic);
    }
  };
  send({ type: 'init', walkLimit: options.walkLimit, scenario: options.scenario, seed: options.seed, speed });

  let ready = false;
  const resize = (): void => {
    const w = canvas.clientWidth;
    const h = canvas.clientHeight;
    renderer.setSize(w, h, false);
    mapCamera.resize(w, h);
  };
  const observer = new ResizeObserver(resize);
  observer.observe(canvas);
  resize();

  let frames = 0;
  let fps = 0;
  let fpsWindowStart = performance.now();
  let raf = 0;
  const frame = (now: number): void => {
    raf = requestAnimationFrame(frame);
    vehicles?.update(now);
    mapCamera.update();
    editor?.update();
    renderer.render(scene, mapCamera.camera);
    frames++;
    if (now - fpsWindowStart >= 500) {
      fps = (frames * 1000) / (now - fpsWindowStart);
      frames = 0;
      fpsWindowStart = now;
    }
  };
  raf = requestAnimationFrame(frame);

  const game: Game = {
    editor: () => editor?.state() ?? null,
    setAngleSnapping: (enabled) => editor?.setAngleSnapping(enabled),
    setActuated(value) { if (editor) editor.actuated = value; },
    setRoadType(type) { editor?.setRoadType(type); },
    setTool(tool) {
      editor?.setTool(tool);
      if (zoneLayer) zoneLayer.visible = gridVisible();
    },
    setLotColumns: columns => editor?.setLotColumns(columns),
    setBrush: (brush) => editor?.setBrush(brush),
    undo: () => editor?.undo(),
    cancelRoadEdit: () => editor?.cancel(),
    stats: () => (ready ? latestStats : null),
    walkerPositions: () => walkerPositions,
    town: () => latestTown,
    selectedHouse: () => selectedHouse,
    selectHouse,
    worldToScreen: point => mapCamera.worldToScreen(point),
    selectedParcelOnScreen: () => houses?.selectedBounds ? mapCamera.screenBounds(houses.selectedBounds) : null,
    revealSelectedParcel: area => { if (houses?.selectedBounds) mapCamera.reveal(houses.selectedBounds, area); },
    fps: () => fps,
    speed: () => speed,
    setSpeed(next) {
      speed = next;
      send({ type: 'setSpeed', speed });
    },
    traffic: () => traffic,
    approachName: lane => laneNames[lane] ?? 'Junction',
    setTrafficView(show) {
      trafficVisible = show;
      if (trafficLayer) trafficLayer.group.visible = show;
      if (show && traffic) trafficLayer?.update(traffic);
    },
    setParkingView(show) { occupancy = show; if (latestTown) drawParking(latestTown); },
    showLanes: () => showLanes,
    setShowLanes(show) {
      showLanes = show;
      if (laneOverlay) laneOverlay.visible = show;
    },
    dispose() {
      cancelAnimationFrame(raf);
      observer.disconnect();
      editor?.dispose();
      mapCamera.dispose();
      disposeLayer(scene);
      worker.terminate();
      renderer.dispose();
    },
  };
  window.__towns = game;
  return game;
}

declare global {
  interface Window {
    /** Debug / test handle (used by Playwright). */
    __towns?: Game;
  }
}
