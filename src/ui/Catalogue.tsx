import { edgeOffset, ROAD_ORDER, ROAD_TYPES } from '../sim/network/roadTypes';
import { PALETTE } from '../render/palette';
import { useEffect, useRef } from 'react';
import { BLUEPRINTS } from '../buildings/catalogue';
import { PreviewRenderer } from '../render/buildings/preview';
import { VEHICLES } from '../vehicles/catalogue';
import './catalogue.css';

export function Catalogue() {
  const root = useRef<HTMLElement>(null);
  useEffect(() => {
    const renderer = new PreviewRenderer();
    try {
      for (const canvas of root.current!.querySelectorAll('canvas')) {
        const design = BLUEPRINTS.find(b => b.id === canvas.dataset.design);
        if (canvas.dataset.vehicle) renderer.vehicle(canvas, Number(canvas.dataset.vehicle));
        else if (design) renderer.sheet(canvas, design);
        else renderer.street(canvas);
      }
      root.current!.dataset.ready = 'true';
    } finally {
      renderer.dispose();
    }
  }, []);
  return <main ref={root} className="catalogue">
    <header><span className="wordmark">Towns / Low density</span>
      <h1>Town catalogue</h1>
      <nav aria-label="Catalogue sections">{['cheap', 'mid', 'expensive', 'shops', 'workplaces', 'roads', 'vehicles', 'street'].map(id =>
        <a key={id} href={'#' + id}>{id === 'street' ? 'Sample street' : id}</a>)}</nav>
    </header>
    <p>Selected wall and roof combinations · Lot sizes in zone cells</p>
    {(['cheap', 'mid', 'expensive', 'shops', 'workplaces'] as const).map(tier => <section key={tier} id={tier}>
      <h2>{tier}</h2>
      <div className="design-grid">{BLUEPRINTS.filter(b => b.zone === 'residential' ? b.tier === tier : b.zone === tier).map(b =>
        <figure key={b.id}><figcaption><strong>{b.name}</strong><span>{b.lot.columns} × {b.lot.rows}</span></figcaption>
          <canvas width={1024} data-design={b.id} aria-label={b.name + ' colour and mirrored variants'} />
        </figure>)}</div>
    </section>)}
    <section id="roads"><h2>Road cross-sections</h2>
      <div className="design-grid">{ROAD_ORDER.map(type => {
        const road = ROAD_TYPES[type];
        const layers = (side: 'left' | 'right') => road.strips.filter(strip => strip.side === 'both' || strip.side === side);
        const travel = { kind: 'lane' as const, width: road.laneWidth };
        const bands = [...layers('left').reverse(), travel, travel, ...layers('right')];
        return <figure key={type}><figcaption><strong>{road.name}</strong><span>{Math.round(3.6 * road.speedLimit)} km/h</span></figcaption>
          <div className="road-section">{bands.map((band, i) => <span key={i} style={{ width: band.width * 20, background: band.kind === 'lane' ? PALETTE.roadSurface : PALETTE[band.kind] }}>
            {band.kind === 'lane' ? (i === layers('left').length ? '↓' : '↑') : band.kind === 'parking' ? 'P' : 'Walk'}
          </span>)}</div>
          <small>{edgeOffset(type, 'left') + edgeOffset(type, 'right')} m wide · ${road.cost}/m · ${road.upkeep}/m daily upkeep</small>
        </figure>;
      })}</div>
    </section>
    <section id="vehicles"><h2>Vehicles</h2>
      <div className="design-grid">{VEHICLES.map(type =>
        <figure key={type.model}><figcaption><strong>{type.name}</strong><span>{type.length} × {type.width} m</span></figcaption>
          <canvas width={512} data-vehicle={type.model} aria-label={type.name} />
        </figure>)}</div>
    </section>
    <section id="street"><h2>Sample street</h2><p>Garden Road · 16 lots</p>
      <canvas width={1920} aria-label="Sixteen generated residential lots lining Garden Road" />
    </section>
  </main>;
}
