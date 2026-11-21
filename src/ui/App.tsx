import { PALETTE } from '../render/palette';
import { Disclosure } from './Disclosure';
import { BUDGET } from '../sim/town/economy';
import { ROAD_ORDER, ROAD_TYPES, type RoadType } from '../sim/network/roadTypes';
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { Game } from '../render/game';
import { ZONE_KINDS, type LandUse } from '../sim/zoning/paint';
import { BudgetPanel, money, dayClock, HouseholdCard, TownPanel } from './town';

const SPEEDS = [1, 2, 4, 8] as const;
type Editor = ReturnType<Game['editor']>;

type Tool = NonNullable<Editor>['tool'];
interface TrayTool {
  tool: Tool;
  label: string;
  action: string;
  path: string;
  shortcut?: string;
}
interface ToolGroup {
  name: string;
  icon: string;
  tools: TrayTool[];
}
const ROAD_ICON = 'M5 3 3 17m12-14 2 14M10 3v3m0 3v3m0 3v2';
const ZONE_ICON = 'M3 3h6v6H3zm9 0h5v6h-5zM3 12h6v5H3zm9 0h5v5h-5z';
const GROUPS: ToolGroup[] = [
  { name: 'Roads', icon: ROAD_ICON, tools: [
    { tool: 'road', label: 'Road', action: 'Build road', shortcut: 'R', path: ROAD_ICON },
    { tool: 'curve', label: 'Curve', action: 'Build curved road', shortcut: 'C', path: 'M2 16C13 16 5 4 18 4M2 12c7 0 1-12 16-12' },
    { tool: 'lights', label: 'Lights', action: 'Build traffic lights', shortcut: 'J', path: 'M7 2h6v12H7zM10 14v4M9 5h2M9 8h2M9 11h2' },
    { tool: 'upgrade', label: 'Upgrade', action: 'Upgrade road', shortcut: 'U', path: 'M5 16V5m-3 3 3-3 3 3m7-4v11m-3-3 3 3 3-3' },
  ] },
  { name: 'People', icon: 'M11 5a2 2 0 1 0 0-4 2 2 0 0 0 0 4ZM5 12l3-4 3-1 2 4 4 1M10 8l-1 6-4 4m4-5 4 2 1 4', tools: [
    { tool: 'footpath', label: 'Path', action: 'Build footpath', path: 'M2 16c4 0 8-2 7-6S10 4 17 3M4 18c6 0 11-5 9-9s1-3 5-4' },
    { tool: 'zebra', label: 'Crossing', action: 'Build zebra crossing', path: 'M2 4h16M2 16h16M4 7v6m4-6v6m4-6v6m4-6v6' },
    { tool: 'parking', label: 'Parking', action: 'Build parking lot', path: 'M6 17V3h5a4 4 0 0 1 0 8H6' },
  ] },
  { name: 'Land use', icon: ZONE_ICON, tools: [
    { tool: 'zone', label: 'Zone', action: 'Zone', shortcut: 'Z', path: ZONE_ICON },
    { tool: 'park', label: 'Park', action: 'Build park', path: 'm10 2-6 7h3l-4 5h14l-4-5h3zM10 14v4' },
  ] },
];

function clock(seconds: number): string {
  const s = Math.floor(seconds);
  const hh = String(Math.floor(s / 3600)).padStart(2, '0');
  const mm = String(Math.floor((s % 3600) / 60)).padStart(2, '0');
  const ss = String(s % 60).padStart(2, '0');
  return `${hh}:${mm}:${ss}`;
}

export function App({ game }: { game: Game }) {
  const hud = useRef<HTMLElement>(null);
  const [tray, setTray] = useState<string | null>(null);
  const [stats, setStats] = useState(game.stats());
  const [town, setTown] = useState(game.town());
  const [selected, setSelected] = useState(game.selectedHouse());
  const [editor, setEditor] = useState<Editor>(() => game.editor());
  const [fps, setFps] = useState(0);
  const [speed, setSpeed] = useState(game.speed());
  const [lastSpeed, setLastSpeed] = useState(speed || 1);
  const [occupancy, setOccupancy] = useState(false);
  const [trafficVisible, setTrafficVisible] = useState(false);
  const traffic = game.traffic();
  const jam = traffic && traffic.jam >= 0 ? game.approachName(traffic.jam) : null;
  const [lanes, setLanes] = useState(game.showLanes());

  useEffect(() => {
    const timer = setInterval(() => {
      setStats(game.stats());
      setTown(game.town());
      setSelected(game.selectedHouse());
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
    setTray(null);
    game.setTool(tool);
    setEditor(game.editor());
  };
  const pickType = (type: RoadType) => {
    game.setRoadType(type);
    setEditor(game.editor());
  };
  const roadPicker = editor && ['road', 'curve', 'upgrade'].includes(editor.tool);
  const changeBrush = (brush: LandUse | null): void => {
    game.setBrush(brush);
    setEditor(game.editor());
  };
  const selectHouse = (house: number | null): void => {
    game.selectHouse(house);
    setSelected(house);
  };
  const undo = (): void => {
    game.undo();
    setEditor(game.editor());
    setStats(game.stats());
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (tray && e.key === 'Escape') {
        // Dismiss the tray before the map editor receives Escape and cancels the road draft.
        e.stopImmediatePropagation();
        e.preventDefault();
        setTray(null);
        return;
      }
      if (e.target instanceof HTMLElement && (e.target.isContentEditable || e.target.closest('input, textarea, select'))) return;
      if (e.metaKey || e.ctrlKey) {
        if (editor && e.key.toLowerCase() === 'z' && !e.shiftKey) {
          e.preventDefault();
          if (editor.canUndo && !editor.pending) undo();
        }
        return;
      }
      if (e.altKey || e.repeat) return;
      if (e.key === 'Escape') {
        // Esc finishes a road in progress first; the next one closes the household card.
        if (selected !== null && !editor?.chaining && !editor?.canCancel) selectHouse(null);
      } else if (editor?.tool === 'zone' && ['h', 's', 'w', 'e'].includes(e.key.toLowerCase())) {
        changeBrush(ZONE_KINDS['hswe'.indexOf(e.key.toLowerCase())] ?? null);
      } else if (roadPicker && ['5', '6', '7'].includes(e.key)) {
        pickType(ROAD_ORDER[Number(e.key) - 5]!);
      } else if (editor && e.key.toLowerCase() === 'j') {
        changeTool('lights');
      } else if (editor && e.key.toLowerCase() === 'u') {
        changeTool('upgrade');
      } else if (editor && e.key.toLowerCase() === 'r') {
        changeTool('road');
      } else if (editor && e.key.toLowerCase() === 'c') {
        changeTool('curve');
      } else if (editor && e.key.toLowerCase() === 'b') {
        changeTool('bulldoze');
      } else if (editor && e.key.toLowerCase() === 'z') {
        changeTool('zone');
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
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  });

  const instruction = editor?.hint || (editor?.pending
    ? 'Updating roads…'
    : editor?.tool === 'pan' ? 'Drag the map to pan.'
    : editor?.tool === 'bulldoze' ? 'Select a street segment to remove.'
    : editor?.tool === 'upgrade' ? 'Choose a road type, then click a segment.'
    : editor?.tool === 'curve' ? 'Drag between two points, then place the bend.'
            : editor?.tool === 'footpath' ? 'Drag across open ground to connect walking routes.'
            : editor?.tool === 'lights' ? 'Click a T or four-way junction. $160 to build · $4/day.'
            : editor?.tool === 'zebra' ? 'Click a paved street to add a zebra crossing.'
            : editor?.tool === 'park' ? 'Choose a park size and click empty frontage.'
            : editor?.tool === 'parking' ? 'Choose a size, then click empty frontage beside a street.'
    : editor?.tool === 'zone' ? (editor.brush
      ? 'Drag along the plots beside a street to zone them. Plots fill in toward the street.'
      : 'Drag across zoned plots to clear them and the plots behind.')
    : editor?.connected ? 'Drag across a street for a crossing or from its side for a branch, or click points one by one.'
    : 'Drag between marked ends to connect them, or click points one by one.');
  const household = selected === null ? undefined : town?.households.find((h) => h.home === selected);
  const business = town?.businesses.find(b => b.home === selected);
  const inspecting = !!(household || business);
  useLayoutEffect(() => {
    if (!inspecting || !hud.current) return;
    const root = hud.current;
    const panels = Array.from(root.querySelectorAll<HTMLElement>('.panel'));
    const left = root.querySelector<HTMLElement>('.hud-column.left')!;
    const right = root.querySelector<HTMLElement>('.hud-column.right')!;
    const budget = right.querySelector<HTMLElement>('.budget')!;
    const card = right.querySelector<HTMLElement>('.household')!;
    const toolbar = root.querySelector<HTMLElement>('.editor')!;
    const reveal = () => {
      const parcel = game.selectedParcelOnScreen();
      if (!parcel) return;
      const margin = 8;
      const visible = parcel.left >= margin && parcel.top >= margin &&
        parcel.right <= root.clientWidth - margin && parcel.bottom <= root.clientHeight - margin;
      if (visible && panels.every(panel => {
        const r = panel.getBoundingClientRect();
        return parcel.right + margin <= r.left || parcel.left >= r.right + margin ||
          parcel.bottom + margin <= r.top || parcel.top >= r.bottom + margin;
      })) return;
      const narrow = window.matchMedia('(max-width: 640px)').matches;
      const x = narrow ? margin : left.getBoundingClientRect().right + margin;
      const y = narrow ? Math.max(left.getBoundingClientRect().bottom, budget.getBoundingClientRect().bottom) + margin : margin;
      const endX = narrow ? root.clientWidth - margin : right.getBoundingClientRect().left - margin;
      const endY = (narrow ? card : toolbar).getBoundingClientRect().top - margin;
      game.revealSelectedParcel(new DOMRect(x, y, endX - x, endY - y));
    };
    const observer = new ResizeObserver(reveal);
    for (const el of [root, ...panels]) observer.observe(el);
    reveal();
    return () => observer.disconnect();
  }, [game, selected, inspecting, tray]);
  const tripStatus = editor?.pending ? 'Updating roads' : speed === 0 ? 'Paused' : editor && !editor.connected ? 'Waiting for a connection' : 'Traffic running';

  const openGroup = GROUPS.find(group => group.name === tray);
  const viewsButton = <button className="tool" aria-label="Views" aria-expanded={tray === 'Views'}
    onClick={() => setTray(tray === 'Views' ? null : 'Views')}>
    <svg viewBox="0 0 20 20" aria-hidden="true"><path d="m2 7 8-4 8 4-8 4zM2 10l8 4 8-4M2 13l8 4 8-4" /></svg><span>Views</span>
  </button>;
  const viewsTray = tray === 'Views' && <div className="tool-tray panel" role="group" aria-label="Map overlays">
    <label className="toggle"><input type="checkbox" checked={trafficVisible} onChange={e => {
      setTrafficVisible(e.target.checked);
      game.setTrafficView(e.target.checked);
    }} />Traffic view</label>
    {town && <label className="toggle"><input type="checkbox" checked={occupancy} onChange={e => {
      setOccupancy(e.target.checked);
      game.setParkingView(e.target.checked);
    }} />Parking occupancy</label>}
    <label className="toggle"><input type="checkbox" checked={lanes} onChange={toggleLanes} />Lane graph <kbd>L</kbd></label>
  </div>;
  return (
    <aside ref={hud} className={inspecting ? 'hud inspecting' : 'hud'} aria-label="Map controls">
      <div className="hud-column left">
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
        {town && <TownPanel town={town} jam={jam} />}
      </div>

      <div className="hud-column right">
        <section className="simulation panel" aria-label="Simulation">
          <Disclosure heading={<div className="simulation-heading"><span>Simulation</span><time className="clock">{town ? dayClock(town) : stats ? clock(stats.time) : '00:00:00'}</time></div>}>
            <div className="controls" role="group" aria-label="Simulation speed">
              <button className={speed === 0 ? 'active pause' : 'pause'} onClick={() => changeSpeed(speed === 0 ? lastSpeed : 0)} aria-label={speed === 0 ? 'Resume simulation' : 'Pause simulation'} title="Pause / resume (Space)" aria-pressed={speed === 0}>
                <span aria-hidden="true">{speed === 0 ? '▶' : 'Ⅱ'}</span>
              </button>
              {SPEEDS.map((s, i) => (
                <button key={s} className={speed === s ? 'active' : ''} onClick={() => changeSpeed(s)} aria-label={`${s}× speed`} aria-pressed={speed === s} title={`${s}× speed (${i + 1})`}>{s}×</button>
              ))}
            </div>
          {trafficVisible && <div className="traffic-key">
            <div>{(['free', 'slow', 'jammed'] as const).map(level => <span key={level}>
              <i style={{ background: PALETTE.traffic[level] }} />{level}</span>)}</div>
            {traffic && traffic.worst >= 0 && <p>◎ {game.approachName(traffic.worst)} · {traffic.queue[traffic.worst]} queuing</p>}
          </div>}
            <details className="traffic-details">
              <summary>Traffic details</summary>
              <dl>
                <dt>Vehicles</dt><dd>{stats?.active ?? 0}</dd>
                <dt>Trips / min</dt><dd>{stats?.completedLastMinute ?? 0}</dd>
                <dt>Avg speed</dt><dd>{stats ? `${(stats.meanSpeed * 3.6).toFixed(0)} km/h` : '–'}</dd>
                <dt>Stopped</dt><dd>{stats ? `${(stats.stoppedShare * 100).toFixed(0)}%` : '–'}</dd>
                <dt>Avg trip</dt><dd>{stats ? `${stats.meanTripTime.toFixed(0)} s` : '–'}</dd>
              </dl>
              <div className="performance">{fps.toFixed(0)} fps</div>
            </details>
          </Disclosure>
        </section>
        {business && <section key={business.home} className="household panel" aria-label="Business">
          <Disclosure heading={<><span className="panel-heading">{business.zone === 'shops' ? 'Shop' : 'Workplace'}</span>
            <h2 className="household-name">{business.name}</h2></>}
            action={<button className="close" onClick={() => selectHouse(null)} aria-label="Close business card">×</button>}>
          <dl><dt>Jobs filled</dt><dd>{business.filled} / {business.jobs}</dd>
            <dt>Yesterday’s wages and taxes</dt><dd>{money(business.lastDailyCost)}</dd>
            <dt>Taxes paid to date</dt><dd>{money(business.taxesPaid)}</dd>
            <dt>Deliveries today</dt><dd>{business.deliveries}</dd>
            <dt>Parking</dt><dd>{business.occupied}/{business.capacity} · {business.turnedAway} turned away today</dd>
            <dt>Customers today</dt><dd>{business.customers}</dd></dl></Disclosure>
        </section>}
        {household && <HouseholdCard key={household.home} household={household} onClose={() => selectHouse(null)} />}
        {town && <BudgetPanel town={town} />}
      </div>

      {editor && <section className="editor" aria-label="Road editor">
        <div className="placement-info panel">
          {roadPicker && <label className="road-picker">Road type <select value={editor.roadType}
            onChange={event => { const type = ROAD_ORDER[event.target.selectedIndex]; if (type) pickType(type); }}>
            {ROAD_ORDER.map((type, i) => <option key={type} value={type}>{ROAD_TYPES[type].name} · {i + 5}</option>)}
          </select></label>}
          {editor.cost !== null && <strong className="preview-cost">{editor.cost < 0 ? 'Refund' : 'Costs'} {money(Math.abs(editor.cost))}</strong>}
          <p role="status" aria-live="polite">{instruction}</p>
          {editor.canCancel && editor.pending && speed === 0 && <button className="cancel-edit" onClick={() => changeSpeed(lastSpeed)}>Resume traffic</button>}
          {editor.canCancel && <button className="cancel-edit" onClick={() => game.cancelRoadEdit()}>Cancel edit</button>}
          {editor.chaining && <button className="cancel-edit" onClick={() => {
            game.cancelRoadEdit();
            setEditor(game.editor());
          }}>Finish road</button>}
          {editor.tool === 'park' && <label className="road-picker">Park size <select value={editor.lotColumns} onChange={e => { game.setLotColumns(Number(e.target.value)); setEditor(game.editor()); }}>
            {[1,2,3].map(n=><option key={n} value={n}>{n} × {n} · {money(n*n*BUDGET.parkPerCell)}</option>)}
          </select></label>}
          {editor.tool === 'parking' && <label className="road-picker">Lot size <select value={editor.lotColumns} onChange={e => { game.setLotColumns(Number(e.target.value)); setEditor(game.editor()); }}>
            {[1, 2, 3].map(n => <option key={n} value={n}>{n * 2} spaces · {money(n * BUDGET.parkingPerCell)}</option>)}
          </select></label>}
          {editor.tool === 'road' && <label className="angle-toggle">
            <input type="checkbox" checked={editor.angleSnapping} onChange={(e) => {
              game.setAngleSnapping(e.target.checked);
              setEditor(game.editor());
            }} /> Angle snap
          </label>}
          {editor.tool === 'zone' && <span className="zone-brush" role="radiogroup" aria-label="Zone brush">
            {[...ZONE_KINDS, null].map((kind, index) => (
              <button key={kind ?? 'erase'} role="radio" title={'Brush (' + 'HSWE'[index] + ')'} aria-keyshortcuts={'HSWE'[index]} aria-checked={editor.brush === kind} className={editor.brush === kind ? 'active' : ''} onClick={() => changeBrush(kind)}>
                {kind ? kind[0]!.toUpperCase() + kind.slice(1) : 'Erase'}
              </button>
            ))}
          </span>}
          <span className="mouse-help">{editor.tool === 'pan' ? '' : editor.chaining ? 'Esc finishes · ' : 'Esc cancels · '}Scroll to zoom · Right-drag to pan</span>
        </div>
        {viewsTray}
        {openGroup && <div className="tool-tray panel" role="group" aria-label={openGroup.name + ' tools'}>
          {openGroup.tools.map(({ tool, label, action, path, shortcut }) => <button key={tool}
            aria-label={action} aria-pressed={editor.tool === tool} aria-keyshortcuts={shortcut}
            title={shortcut ? `${action} (${shortcut})` : action}
            className={editor.tool === tool ? 'active tool' : 'tool'} onClick={() => changeTool(tool)}>
            <svg viewBox="0 0 20 20" aria-hidden="true"><path d={path} /></svg>
            <span>{label}</span>{shortcut && <kbd>{shortcut}</kbd>}
          </button>)}
        </div>}
        <div className="tool-bar panel" role="group" aria-label="Map tools">
          {GROUPS.map(group => <button key={group.name} aria-expanded={tray === group.name}
            className={'tool' + (group.tools.some(entry => entry.tool === editor.tool) ? ' active' : '')}
            onClick={() => setTray(tray === group.name ? null : group.name)}>
            <svg viewBox="0 0 20 20" aria-hidden="true"><path d={group.icon} /></svg>
            <span>{group.name}</span>
          </button>)}
          {viewsButton}
          <button aria-label="Bulldoze road" aria-pressed={editor.tool === 'bulldoze'} aria-keyshortcuts="B" className={editor.tool === 'bulldoze' ? 'active tool bulldoze' : 'tool bulldoze'} onClick={() => changeTool('bulldoze')} title="Bulldoze road (B)">
            <svg viewBox="0 0 20 20" aria-hidden="true"><path d="M3 12V8h6l2 4M5 8V5h4l1 3m2 5 3 1m1-6v6l2 2h-3l-1-3"/><rect x="2" y="12" width="10" height="4" rx="2"/></svg><span>Bulldoze</span><kbd>B</kbd>
          </button>
          <button aria-label="Pan" aria-pressed={editor.tool === 'pan'} aria-keyshortcuts="V" className={editor.tool === 'pan' ? 'active tool' : 'tool'} onClick={() => changeTool('pan')} title="Pan (V)">
            <svg viewBox="0 0 20 20" aria-hidden="true"><path d="M10 2v16M2 10h16M7 5l3-3 3 3M7 15l3 3 3-3M5 7l-3 3 3 3m10-6 3 3-3 3" /></svg><span>Pan</span><kbd>V</kbd>
          </button>
          <span className="tool-divider" />
          <button aria-label="Undo" aria-keyshortcuts="Control+Z Meta+Z" className="tool undo" onClick={undo} disabled={!editor.canUndo || editor.pending} title="Undo (Ctrl / ⌘ Z)">
            <svg viewBox="0 0 20 20" aria-hidden="true"><path d="M7 4 3 8l4 4M3 8h8a5 5 0 0 1 0 10" /></svg><span>Undo</span>
          </button>
        </div>
      </section>}
      {!editor && <div className="study-views">{viewsTray}<div className="panel">{viewsButton}</div></div>}
    </aside>
  );
}
