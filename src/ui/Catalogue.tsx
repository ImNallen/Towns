import { useEffect, useRef } from 'react';
import { BLUEPRINTS } from '../buildings/catalogue';
import { PreviewRenderer } from '../render/buildings/preview';
import './catalogue.css';

export function Catalogue() {
  const root = useRef<HTMLElement>(null);
  useEffect(() => {
    const renderer = new PreviewRenderer();
    try {
      for (const canvas of root.current!.querySelectorAll('canvas')) {
        const design = BLUEPRINTS.find(b => b.id === canvas.dataset.design);
        if (design) renderer.sheet(canvas, design);
        else renderer.street(canvas);
      }
      root.current!.dataset.ready = 'true';
    } finally {
      renderer.dispose();
    }
  }, []);
  return <main ref={root} className="catalogue">
    <header><span className="wordmark">Towns / Low density</span>
      <h1>Building catalogue</h1>
      <nav aria-label="Catalogue sections">{['cheap', 'mid', 'expensive', 'shops', 'workplaces', 'street'].map(id =>
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
    <section id="street"><h2>Sample street</h2><p>Garden Road · 16 lots</p>
      <canvas width={1920} aria-label="Sixteen generated residential lots lining Garden Road" />
    </section>
  </main>;
}
