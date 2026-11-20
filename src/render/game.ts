import * as THREE from 'three';
import type { Network } from '../sim/network/types';
import type { ScenarioName } from '../sim/scenarios';
import type { SimStats } from '../sim/world';
import type { FromWorker, ToWorker } from '../worker/protocol';
import { MapCamera } from './camera';
import { buildLaneOverlay } from './debug';
import { disposeLayer } from './dispose';
import { RoadEditor, type EditorState, type MapTool } from './roadEditor';
import { buildDecor } from './decor';
import { PALETTE } from './palette';
import { buildRoads } from './roads';
import { VehicleLayer } from './vehicles';

export interface GameOptions {
  scenario: ScenarioName;
  seed: number;
  speed: number;
  showLanes: boolean;
  /** Optional initial view: centre (world meters) and meters per pixel. */
  view?: { x: number; y: number; mpp: number };
}

export interface Game {
  editor(): EditorState | null;
  setAngleSnapping(enabled: boolean): void;
  setTool(tool: MapTool): void;
  undoRoad(): void;
  cancelRoadEdit(): void;
  stats(): SimStats | null;
  fps(): number;
  speed(): number;
  setSpeed(speed: number): void;
  showLanes(): boolean;
  setShowLanes(show: boolean): void;
  dispose(): void;
}

/**
 * Lighting is tuned so up-facing surfaces render at exactly their palette colour:
 * Lambert output = albedo · (ambient + sun · cosθ) / π, and we make that bracket equal π.
 * Shadowed ground keeps only the ambient share (~75% brightness).
 */
const SUN_DIRECTION = new THREE.Vector3(-160, 300, -200).normalize(); // from the north-west
const SUN_INTENSITY = 1.0;
const AMBIENT_INTENSITY = Math.PI - SUN_INTENSITY * SUN_DIRECTION.y;

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
  let vehicles: VehicleLayer | null = null;
  let laneOverlay: THREE.Group | null = null;
  let showLanes = options.showLanes;
  let speed = options.speed;
  let latestStats: SimStats | null = null;

  const worker = new Worker(new URL('../worker/sim.worker.ts', import.meta.url), { type: 'module' });
  const send = (msg: ToWorker): void => worker.postMessage(msg);

  if (options.scenario === 'meadow') editor = new RoadEditor(canvas, mapCamera, scene, send, (visible) => {
    if (roadLayer) roadLayer.visible = visible;
  });

  const drawNetwork = (network: Network): void => {
    if (roadLayer) disposeLayer(roadLayer);
    if (laneOverlay) disposeLayer(laneOverlay);
    roadLayer = buildRoads(network, editor ? 'dashed' : 'solid');
    laneOverlay = buildLaneOverlay(network);
    laneOverlay.visible = showLanes;
    scene.add(roadLayer, laneOverlay);
  };

  worker.onmessage = (e: MessageEvent<FromWorker>) => {
    const msg = e.data;
    if (msg.type === 'ready') {
      const { scenario } = msg;
      scene.add(buildDecor(scenario.decor));
      drawNetwork(scenario.network);
      if (editor) editor.accept([]);
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
      editor?.accept(msg.edits);
    } else if (msg.type === 'editWaiting') {
      editor?.waitForTraffic();
    } else if (msg.type === 'editRejected') {
      editor?.reject(msg.reason);
    } else {
      vehicles?.push(msg, performance.now());
      latestStats = msg.stats;
    }
  };
  send({ type: 'init', scenario: options.scenario, seed: options.seed, speed });

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
    setTool: (tool) => editor?.setTool(tool),
    undoRoad: () => editor?.undo(),
    cancelRoadEdit: () => editor?.cancel(),
    stats: () => (ready ? latestStats : null),
    fps: () => fps,
    speed: () => speed,
    setSpeed(next) {
      speed = next;
      send({ type: 'setSpeed', speed });
    },
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
