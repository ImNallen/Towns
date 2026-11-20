import { useEffect, useState } from 'react';
import type { Game } from '../render/game';

const SPEEDS = [1, 2, 4, 8] as const;
type Editor = ReturnType<Game['editor']>;

function clock(seconds: number): string {
  const s = Math.floor(seconds);
  const hh = String(Math.floor(s / 3600)).padStart(2, '0');
  const mm = String(Math.floor((s % 3600) / 60)).padStart(2, '0');
  const ss = String(s % 60).padStart(2, '0');
  return `${hh}:${mm}:${ss}`;
}

export function App({ game }: { game: Game }) {
  const [stats, setStats] = useState(game.stats());
  const [editor, setEditor] = useState<Editor>(() => game.editor());
  const [fps, setFps] = useState(0);
  const [speed, setSpeed] = useState(game.speed());
  const [lastSpeed, setLastSpeed] = useState(speed || 1);
  const [lanes, setLanes] = useState(game.showLanes());

  useEffect(() => {
    const timer = setInterval(() => {
      setStats(game.stats());
      setEditor(game.editor());
      setFps(game.fps());
    }, 100);
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
  const changeTool = (tool: NonNullable<Editor>['tool']): void => {
    game.setTool(tool);
    setEditor(game.editor());
  };
  const undo = (): void => {
    game.undoRoad();
    setEditor(game.editor());
    setStats(game.stats());
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.target instanceof HTMLElement && (e.target.isContentEditable || e.target.closest('input, textarea, select'))) return;
      if (e.metaKey || e.ctrlKey) {
        if (editor && e.key.toLowerCase() === 'z' && !e.shiftKey) {
          e.preventDefault();
          if (editor.canUndo && !editor.pending) undo();
        }
        return;
      }
      if (e.altKey || e.repeat) return;
      if (editor && e.key.toLowerCase() === 'r') {
        changeTool('road');
      } else if (editor && e.key.toLowerCase() === 'c') {
        changeTool('curve');
      } else if (editor && e.key.toLowerCase() === 'b') {
        changeTool('bulldoze');
      } else if (editor && e.key.toLowerCase() === 'v') {
        changeTool('pan');
      } else if (e.code === 'Space') {
        if (e.target instanceof HTMLElement && e.target.closest('button, summary')) return;
        e.preventDefault();
        changeSpeed(speed === 0 ? lastSpeed : 0);
      } else if (e.key >= '1' && e.key <= '4') {
        const next = SPEEDS[Number(e.key) - 1];
        if (next !== undefined) changeSpeed(next);
      } else if (e.key.toLowerCase() === 'l') {
        toggleLanes();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  const instruction = editor?.hint || (editor?.pending
    ? 'Updating roads…'
    : editor?.tool === 'pan' ? 'Drag the map to pan.'
    : editor?.tool === 'bulldoze' ? 'Select a street segment to remove.'
    : editor?.tool === 'curve' ? 'Drag between two points, then place the bend.'
    : editor?.connected ? 'Drag across a street for a crossing or from its side for a branch, or click points one by one.'
    : 'Drag between marked ends to connect them, or click points one by one.');
  const tripStatus = editor?.pending ? 'Updating roads' : speed === 0 ? 'Paused' : editor && !editor.connected ? 'Waiting for a connection' : 'Traffic running';

  return (
    <aside className="hud" aria-label="Map controls">
      <section className="map-info panel" aria-label="Map objective">
        <header className="map-heading">
          <span className="wordmark">Towns</span>
        </header>
        <h1>{editor ? 'Meadow Vale' : 'Traffic study'}</h1>
        {editor && <div className={`objective${editor.connected ? ' is-complete' : ''}`}>
          <span className="objective-marker" aria-hidden="true">{editor.connected ? '✓' : '○'}</span>
          <h2>{editor.connected ? 'Neighborhoods connected' : 'Connect the two neighborhoods'}</h2>
        </div>}
        <div className="trip-summary">
          <div><strong>{stats?.completed ?? 0}</strong><span>{stats?.completed === 1 ? 'trip' : 'trips'} completed</span></div>
          <span className="traffic-status"><i className={speed > 0 && (!editor || editor.connected) && !editor?.pending ? 'running' : ''} aria-hidden="true" />{tripStatus}</span>
        </div>
      </section>

      <section className="simulation panel" aria-label="Simulation">
        <div className="simulation-heading"><span>Simulation</span><time className="clock">{stats ? clock(stats.time) : '00:00:00'}</time></div>
        <div className="controls" role="group" aria-label="Simulation speed">
          <button className={speed === 0 ? 'active pause' : 'pause'} onClick={() => changeSpeed(speed === 0 ? lastSpeed : 0)} aria-label={speed === 0 ? 'Resume simulation' : 'Pause simulation'} title="Pause / resume (Space)" aria-pressed={speed === 0}>
            <span aria-hidden="true">{speed === 0 ? '▶' : 'Ⅱ'}</span>
          </button>
          {SPEEDS.map((s, i) => (
            <button key={s} className={speed === s ? 'active' : ''} onClick={() => changeSpeed(s)} aria-label={`${s}× speed`} aria-pressed={speed === s} title={`${s}× speed (${i + 1})`}>{s}×</button>
          ))}
        </div>
        <details className="traffic-details">
          <summary>Traffic details</summary>
          <dl>
            <dt>Vehicles</dt><dd>{stats?.active ?? 0}</dd>
            <dt>Trips / min</dt><dd>{stats?.completedLastMinute ?? 0}</dd>
            <dt>Avg speed</dt><dd>{stats ? `${(stats.meanSpeed * 3.6).toFixed(0)} km/h` : '–'}</dd>
            <dt>Stopped</dt><dd>{stats ? `${(stats.stoppedShare * 100).toFixed(0)}%` : '–'}</dd>
            <dt>Avg trip</dt><dd>{stats ? `${stats.meanTripTime.toFixed(0)} s` : '–'}</dd>
            <dt>Cleared by edits</dt><dd>{stats?.cleared ?? 0}</dd>
          </dl>
          <label className="toggle"><input type="checkbox" checked={lanes} onChange={toggleLanes} />Lane graph <kbd>L</kbd></label>
          <div className="performance">{fps.toFixed(0)} fps</div>
        </details>
      </section>

      {editor && <section className="editor" aria-label="Road editor">
        <div className="placement-info panel">
          <p role="status" aria-live="polite">{instruction}</p>
          {editor.canCancel && <button className="cancel-edit" onClick={() => game.cancelRoadEdit()}>Cancel edit</button>}
          {editor.chaining && <button className="cancel-edit" onClick={() => {
            game.cancelRoadEdit();
            setEditor(game.editor());
          }}>Finish road</button>}
          {editor.tool === 'road' && <label className="angle-toggle">
            <input type="checkbox" checked={editor.angleSnapping} onChange={(e) => {
              game.setAngleSnapping(e.target.checked);
              setEditor(game.editor());
            }} /> Angle snap
          </label>}
          <span className="mouse-help">{editor.tool === 'pan' ? '' : editor.chaining ? 'Esc finishes · ' : 'Esc cancels · '}Scroll to zoom · Right-drag to pan</span>
        </div>
        <div className="tool-bar panel" role="group" aria-label="Map tools">
          <button aria-label="Build road" aria-pressed={editor.tool === 'road'} aria-keyshortcuts="R" className={editor.tool === 'road' ? 'active tool' : 'tool'} onClick={() => changeTool('road')} title="Build road (R)">
            <svg viewBox="0 0 20 20" aria-hidden="true"><path d="m5 3-2 14m12-14 2 14M10 3v3m0 3v3m0 3v2" /></svg><span>Road</span><kbd>R</kbd>
          </button>
          <button aria-label="Build curved road" aria-pressed={editor.tool === 'curve'} aria-keyshortcuts="C" className={editor.tool === 'curve' ? 'active tool' : 'tool'} onClick={() => changeTool('curve')} title="Build curved road (C)">
            <svg viewBox="0 0 20 20" aria-hidden="true"><path d="M2 16C13 16 5 4 18 4M2 12c7 0 1-12 16-12" /></svg><span>Curve</span><kbd>C</kbd>
          </button>
          <button aria-label="Bulldoze road" aria-pressed={editor.tool === 'bulldoze'} aria-keyshortcuts="B" className={editor.tool === 'bulldoze' ? 'active tool bulldoze' : 'tool bulldoze'} onClick={() => changeTool('bulldoze')} title="Bulldoze road (B)">
            <svg viewBox="0 0 20 20" aria-hidden="true"><path d="M3 12V8h6l2 4M5 8V5h4l1 3m2 5 3 1m1-6v6l2 2h-3l-1-3"/><rect x="2" y="12" width="10" height="4" rx="2"/></svg><span>Bulldoze</span><kbd>B</kbd>
          </button>
          <button aria-label="Pan" aria-pressed={editor.tool === 'pan'} aria-keyshortcuts="V" className={editor.tool === 'pan' ? 'active tool' : 'tool'} onClick={() => changeTool('pan')} title="Pan (V)">
            <svg viewBox="0 0 20 20" aria-hidden="true"><path d="M10 2v16M2 10h16M7 5l3-3 3 3M7 15l3 3 3-3M5 7l-3 3 3 3m10-6 3 3-3 3" /></svg><span>Pan</span><kbd>V</kbd>
          </button>
          <span className="tool-divider" />
          <button aria-label="Undo road" aria-keyshortcuts="Control+Z Meta+Z" className="tool undo" onClick={undo} disabled={!editor.canUndo || editor.pending} title="Undo road (Ctrl / ⌘ Z)">
            <svg viewBox="0 0 20 20" aria-hidden="true"><path d="M7 4 3 8l4 4M3 8h8a5 5 0 0 1 0 10" /></svg><span>Undo</span>
          </button>
        </div>
      </section>}
    </aside>
  );
}
