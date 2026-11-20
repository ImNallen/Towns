import { useEffect, useState } from 'react';
import type { Game } from '../render/game';
import type { SimStats } from '../sim/world';

const SPEEDS = [1, 2, 4, 8] as const;

function clock(seconds: number): string {
  const s = Math.floor(seconds);
  const hh = String(Math.floor(s / 3600)).padStart(2, '0');
  const mm = String(Math.floor((s % 3600) / 60)).padStart(2, '0');
  const ss = String(s % 60).padStart(2, '0');
  return `${hh}:${mm}:${ss}`;
}

export function App({ game }: { game: Game }) {
  const [stats, setStats] = useState<SimStats | null>(null);
  const [fps, setFps] = useState(0);
  const [speed, setSpeed] = useState(game.speed());
  const [lastSpeed, setLastSpeed] = useState(speed || 1);
  const [lanes, setLanes] = useState(game.showLanes());

  useEffect(() => {
    const timer = setInterval(() => {
      setStats(game.stats());
      setFps(game.fps());
    }, 250);
    return () => clearInterval(timer);
  }, [game]);

  const changeSpeed = (next: number): void => {
    if (next > 0) setLastSpeed(next);
    setSpeed(next);
    game.setSpeed(next);
  };
  const toggleLanes = (): void => {
    setLanes(!lanes);
    game.setShowLanes(!lanes);
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.target instanceof HTMLInputElement) return;
      if (e.code === 'Space') {
        e.preventDefault();
        changeSpeed(speed === 0 ? lastSpeed : 0);
      } else if (e.key >= '1' && e.key <= '4') {
        changeSpeed(SPEEDS[Number(e.key) - 1]!);
      } else if (e.key === 'l' || e.key === 'L') {
        toggleLanes();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  return (
    <aside className="hud">
      <header>
        <h1>Towns</h1>
        <span className="clock">{stats ? clock(stats.time) : '--:--:--'}</span>
      </header>

      <div className="controls" role="group" aria-label="Simulation speed">
        <button className={speed === 0 ? 'active' : ''} onClick={() => changeSpeed(speed === 0 ? lastSpeed : 0)} title="Pause (Space)">
          {speed === 0 ? '▶' : '❚❚'}
        </button>
        {SPEEDS.map((s, i) => (
          <button key={s} className={speed === s ? 'active' : ''} onClick={() => changeSpeed(s)} title={`${s}× (${i + 1})`}>
            {s}×
          </button>
        ))}
      </div>

      <dl>
        <dt>Vehicles</dt>
        <dd>{stats?.active ?? 0}</dd>
        <dt>Trips / min</dt>
        <dd>{stats?.completedLastMinute ?? 0}</dd>
        <dt>Avg speed</dt>
        <dd>{stats ? `${(stats.meanSpeed * 3.6).toFixed(0)} km/h` : '–'}</dd>
        <dt>Stopped</dt>
        <dd>{stats ? `${(stats.stoppedShare * 100).toFixed(0)}%` : '–'}</dd>
        <dt>Avg trip</dt>
        <dd>{stats ? `${stats.meanTripTime.toFixed(0)} s` : '–'}</dd>
      </dl>

      <label className="toggle">
        <input type="checkbox" checked={lanes} onChange={toggleLanes} />
        Lane graph <kbd>L</kbd>
      </label>

      <footer>{fps.toFixed(0)} fps</footer>
    </aside>
  );
}
