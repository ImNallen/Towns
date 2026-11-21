import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { createGame, type GameOptions } from './render/game';
import { isScenarioName } from './sim/scenarios';
import { App } from './ui/App';
import './ui/styles.css';

/**
 * URL parameters (handy for screenshots and debugging):
 *   ?scenario=meadow|roundabout|straight  ?seed=1  ?speed=0..8  ?lanes=1  ?zones=1
 *   ?x=0&y=0&mpp=0.15   initial view centre (meters) and zoom (meters per pixel)
 */
function readOptions(): GameOptions {
  const q = new URLSearchParams(location.search);
  const scenario = q.get('scenario') ?? 'meadow';
  const num = (key: string, fallback: number): number => {
    const v = Number(q.get(key));
    return q.has(key) && Number.isFinite(v) ? v : fallback;
  };
  return {
    walkLimit: q.has('walkLimit') ? Math.max(0, num('walkLimit', 600)) : undefined,
    scenario: isScenarioName(scenario) ? scenario : 'meadow',
    seed: num('seed', 1),
    speed: num('speed', 1),
    showLanes: q.get('lanes') === '1',
    showZones: q.get('zones') === '1',
    ...(q.has('mpp') ? { view: { x: num('x', 0), y: num('y', 0), mpp: num('mpp', 0.5) } } : {}),
  };
}

const canvas = document.getElementById('map') as HTMLCanvasElement;
const root = createRoot(document.getElementById('ui')!);
if (new URLSearchParams(location.search).get('catalogue') === '1') {
  canvas.remove();
  void import('./ui/Catalogue').then(({ Catalogue }) => root.render(<Catalogue />));
} else {
  const game = createGame(canvas, readOptions());
  root.render(<StrictMode><App game={game} /></StrictMode>);
}
