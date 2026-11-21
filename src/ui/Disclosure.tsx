import { useId, useState, type ReactNode } from 'react';

/** Phone panels share one heading between their compact and expanded layouts. */
export function Disclosure({ heading, action, children }: { heading: ReactNode; action?: ReactNode; children: ReactNode }) {
  const id = useId();
  const [open, setOpen] = useState(false);
  return <>
    <div className="disclosure-heading">
      <div className="disclosure-title">
        <div id={id}>{heading}</div>
        <button className="phone-heading" aria-labelledby={id} aria-controls={id + '-body'} aria-expanded={open}
          onClick={() => setOpen(!open)}><span aria-hidden="true">{open ? '▴' : '▾'}</span></button>
      </div>
      {action}
    </div>
    <div id={id + '-body'} className="disclosure-content" data-open={open}>{children}</div>
  </>;
}
