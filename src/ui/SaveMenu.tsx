import { useEffect, useRef, useState } from 'react';
import type { Game } from '../render/game';
import { browserSaves, slots, type Slot } from '../platform/saves';

export function SaveMenu({ game, open }: { game: Game; open: boolean }) {
  const [slot, setSlot] = useState<Slot>(slots[0]);
  const [auto, setAuto] = useState('Autosaves every minute');
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);
  const file = useRef<HTMLInputElement>(null);
  useEffect(() => {
    const timer = setInterval(async () => {
      try {
        browserSaves.write('Autosave', await game.save());
        setAuto('Autosaved at ' + new Date().toLocaleTimeString());
      } catch (error) { setAuto(error instanceof Error ? error.message : 'Autosave failed.'); }
    }, 60_000);
    return () => clearInterval(timer);
  }, [game]);

  async function run(work: () => Promise<void>, success: string) {
    setBusy(true);
    setMessage('Working…');
    try { await work(); setMessage(success); }
    catch (error) { setMessage(error instanceof Error ? error.message : 'Could not complete that action.'); }
    finally { setBusy(false); }
  }
  if (!open) return null;
  return <section className="panel save-menu" aria-label="Town saves">
    <fieldset disabled={busy}>
      <select aria-label="Save slot" value={slot} onChange={e => setSlot(slots[e.target.selectedIndex]!)}>
        {slots.map(name => <option key={name}>{name}</option>)}
      </select>
      <button disabled={slot === 'Autosave'} onClick={() => run(async () => browserSaves.write(slot, await game.save()), slot + ' saved.')}>Save</button>
      <button onClick={() => run(() => game.load(browserSaves.read(slot)), slot + ' loaded.')}>Load</button>
      <button onClick={() => run(async () => browserSaves.exportFile(await game.save()), 'Exported town.')}>Export</button>
      <button onClick={() => file.current?.click()}>Import</button>
      <input ref={file} hidden type="file" aria-label="Import town file" accept=".json,application/json" onChange={e => {
        const selected = e.target.files?.[0];
        e.target.value = '';
        if (selected) void run(async () => game.load(await browserSaves.importFile(selected)), 'Imported town.');
      }} />
    </fieldset>
    <small>{auto}</small> <span role="status">{message}</span>
  </section>;
}
