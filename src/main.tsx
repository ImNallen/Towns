import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { createGame, type GameOptions } from './render/game';
import { isScenarioName } from './sim/scenarios';
import { App } from './ui/App';
import './ui/styles.css';

/**
 * URL parameters (handy for screenshots and debugging):
 *   ?scenario=roundabout|straight  ?seed=1  ?speed=0..8  ?lanes=1
 *   ?x=0&y=0&mpp=0.15   initial view centre (meters) and zoom (meters per pixel)
 */
function readOptions(): GameOptions {
  const q = new URLSearchParams(location.search);
  const scenario = q.get('scenario') ?? 'roundabout';
  const num = (key: string, fallback: number): number => {
    const v = Number(q.get(key));
    return q.has(key) && Number.isFinite(v) ? v : fallback;
  };
  return {
    scenario: isScenarioName(scenario) ? scenario : 'roundabout',
    seed: num('seed', 1),
    speed: num('speed', 1),
    showLanes: q.get('lanes') === '1',
    ...(q.has('mpp') ? { view: { x: num('x', 0), y: num('y', 0), mpp: num('mpp', 0.5) } } : {}),
  };
}

const canvas = document.getElementById('map') as HTMLCanvasElement;
const game = createGame(canvas, readOptions());

createRoot(document.getElementById('ui')!).render(
  <StrictMode>
    <App game={game} />
  </StrictMode>,
);
