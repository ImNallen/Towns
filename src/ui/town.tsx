import type { HouseholdView, TownEventView, TownView } from '../sim/town/town';

const FEED_LENGTH = 4;
const ORDINALS = ['first', 'second', 'third', 'fourth', 'fifth'];
export const CAR_MODELS = ['Compact', 'Estate', 'Tourer'] as const;

const pad = (n: number): string => String(n).padStart(2, '0');

export function dayClock(town: TownView): string {
  return `Day ${town.day} · ${pad(Math.floor(town.minuteOfDay / 60))}:${pad(town.minuteOfDay % 60)}`;
}

export function money(amount: number): string {
  const rounded = Math.round(amount);
  return `${rounded < 0 ? '−' : ''}$${Math.abs(rounded).toLocaleString('en-US')}`;
}

export function family(household: HouseholdView): string {
  return `The ${household.surname}${household.surname.endsWith('s') ? 'es' : 's'}`;
}

function memberName(town: TownView, household: number, person: number): string {
  const h = town.households[household]!;
  const first = h.members.find((m) => m.id === person)?.firstName;
  return first ? `${first} ${h.surname}` : family(h);
}

function describe(event: TownEventView, town: TownView): string {
  const household = town.households[event.household]!;
  switch (event.kind) {
    case 'boughtCar': return `${family(household)} bought a ${ORDINALS[event.cars - 1] ?? 'new'} car`;
    case 'newerCar': return `${family(household)} traded up to the ${CAR_MODELS[event.model - 1]}`;
    case 'upgradedHouse': return event.level >= 3
      ? `${family(household)} built a second storey`
      : `${family(household)} moved up to a larger home`;
    case 'newJob': return `${memberName(town, event.household, event.person)} started a job in ${event.region}`;
    case 'changedJob': return `${memberName(town, event.household, event.person)} took a better job in ${event.region}`;
    case 'lostJob': return `${memberName(town, event.household, event.person)} can no longer get to work in ${event.region}`;
  }
}

function when(event: TownEventView, town: TownView): string {
  if (event.day === town.day) return 'Today';
  if (event.day === town.day - 1) return 'Yesterday';
  return `Day ${event.day}`;
}

export function TownPanel({ town }: { town: TownView }) {
  const { totals } = town;
  const upgraded = town.households.filter((h) => h.level > 1).length;
  const recent = town.events.slice(-FEED_LENGTH).reverse();
  return (
    <section className="town panel" aria-label="Residents">
      <div className="panel-heading"><span>Residents</span></div>
      <div className="town-summary">
        <strong>{totals.population}</strong>
        <span>people in {town.households.length} homes</span>
      </div>
      <dl className="town-stats">
        <dt>Employed adults</dt><dd>{totals.employed} / {totals.adults}</dd>
        <dt>Working across town</dt><dd>{totals.crossCommuters}</dd>
        <dt>Cars</dt><dd>{totals.cars}</dd>
        <dt>Homes upgraded</dt><dd>{upgraded}</dd>
        <dt>Avg household funds</dt><dd>{money(totals.meanFunds)}</dd>
      </dl>
      {recent.length > 0 && <ol className="town-feed" aria-label="Recent events">
        {recent.map((event) => (
          <li key={`${event.day}-${event.minute}-${event.household}-${event.kind}-${'person' in event ? `${event.person}-${event.region}` : ''}`}>
            <span>{describe(event, town)}</span>
            <time>{when(event, town)}</time>
          </li>
        ))}
      </ol>}
    </section>
  );
}
