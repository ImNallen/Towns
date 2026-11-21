import { PALETTE } from '../render/palette';
import type { HouseholdView, PersonView, TownEventView, TownView } from '../sim/town/town';

const FEED_LENGTH = 3;
const ORDINALS = ['first', 'second', 'third', 'fourth', 'fifth'];
export const CAR_MODELS = ['Compact', 'Estate', 'Tourer'] as const;
const HOMES = ['Cottage', 'Family home', 'Two-storey home'];

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
      <div className="panel-heading"><span>Residents</span><span>{town.households.length} homes</span></div>
      <dl className="town-stats">
        <div><dt>people</dt><dd>{totals.population}</dd></div>
        <div><dt>adults employed</dt><dd>{totals.employed}/{totals.adults}</dd></div>
        <div><dt>cross-commuting</dt><dd>{totals.crossCommuters}</dd></div>
        <div><dt>cars</dt><dd>{totals.cars}</dd></div>
        <div><dt>homes upgraded</dt><dd>{upgraded}</dd></div>
        <div><dt>avg. funds</dt><dd>{money(totals.meanFunds)}</dd></div>
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

function activity(person: PersonView): string {
  const { place } = person;
  switch (person.activity) {
    case 'home': return 'At home';
    case 'homebound': return 'Driving home';
    case 'outbound': return person.errand === 'work' ? `Driving to work in ${place}` : `Driving to the shops in ${place}`;
    case 'away': return person.errand === 'work' ? `At work in ${place}` : `Shopping in ${place}`;
  }
}

function Need({ label, value }: { label: string; value: number }) {
  const percent = Math.round(value * 100);
  return (
    <div className="need">
      <span>{label}</span>
      <div className={`need-bar${value < 0.34 ? ' low' : ''}`} role="meter" aria-label={label} aria-valuemin={0} aria-valuemax={100} aria-valuenow={percent}>
        <i style={{ width: `${percent}%` }} />
      </div>
    </div>
  );
}

export function HouseholdCard({ household, onClose }: { household: HouseholdView; onClose: () => void }) {
  const { needs } = household;
  const model = CAR_MODELS[household.carModel - 1];
  return (
    <section className="household panel" aria-label="Household">
      <div className="panel-heading">
        <span>{household.region} · {HOMES[household.level - 1]}</span>
        <button className="close" onClick={onClose} aria-label="Close household" title="Close (Esc)">×</button>
      </div>
      <h2 className="household-name">{family(household)}</h2>
      <p className="household-meta">
        <span><i className="car-swatch" style={{ background: PALETTE.carModels[household.carModel - 1] }} aria-hidden="true" />{household.cars} {model}{household.cars === 1 ? '' : 's'}</span>
        <span>{money(household.funds)}</span>
      </p>
      <div className="needs">
        <Need label="Food" value={needs.food} />
        <Need label="Comfort" value={needs.comfort} />
        <Need label="Mobility" value={needs.mobility} />
        <Need label="Security" value={needs.security} />
        <Need label="Happiness" value={household.happiness} />
      </div>
      <ul className="members">
        {household.members.map((person) => (
          <li key={person.id}>
            <div>
              <strong>{person.firstName}, {person.age === 0 ? 'baby' : person.age}</strong>
              {person.role === 'adult' && <span>{person.job ? `Works in ${person.job}` : 'Looking for work'}</span>}
            </div>
            <span className="member-activity">{activity(person)}</span>
          </li>
        ))}
      </ul>
    </section>
  );
}
