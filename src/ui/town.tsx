import { vehicleType } from '../vehicles/catalogue';
import { dollars as money } from '../sim/town/budget';
import { ZONE_KINDS } from '../sim/zoning/paint';
import { PALETTE } from '../render/palette';
import type { HouseholdView, PersonView, TownEventView, TownView } from '../sim/town/town';

const FEED_LENGTH = 3;
const ORDINALS = ['first', 'second', 'third', 'fourth', 'fifth'];
const HOMES = ['Cottage', 'Family home', 'Two-storey home'];

const pad = (n: number): string => String(n).padStart(2, '0');

export function dayClock(town: TownView): string {
  return `Day ${town.day} · ${pad(Math.floor(town.minuteOfDay / 60))}:${pad(town.minuteOfDay % 60)}`;
}

export { money };

export function family(household: HouseholdView): string {
  return `The ${household.surname}${household.surname.endsWith('s') ? 'es' : 's'}`;
}

function memberName(town: TownView, household: number, person: number): string {
  const h = town.households.find(h => h.id === household)!;
  const first = h.members.find((m) => m.id === person)?.firstName;
  return first ? `${first} ${h.surname}` : family(h);
}

function describe(event: TownEventView, town: TownView): string {
  const household = town.households.find(h => h.id === event.household)!;
  switch (event.kind) {
    case 'noWalkRoute': return 'No safe way to walk from the ' + household.surname + ' home to ' + event.region;
    case 'parkingFailed': return (event.shopper ? 'Shoppers' : 'Workers') + ' couldn’t park near ' + event.region;
    case 'movedIn': return `${family(household)} moved into a new home`;
    case 'boughtCar': return `${family(household)} bought a ${ORDINALS[event.cars - 1] ?? 'new'} car`;
    case 'newerCar': return `${family(household)} traded up to the ${vehicleType(event.model).name}`;
    case 'upgradedHouse': return event.level >= 3
      ? `${family(household)} built a second storey`
      : `${family(household)} moved up to a larger home`;
    case 'newJob': return `${memberName(town, event.household, event.person)} started a job ${town.households.some(h => h.region === event.region) ? 'in' : 'at'} ${event.region}`;
    case 'changedJob': return `${memberName(town, event.household, event.person)} took a better job ${town.households.some(h => h.region === event.region) ? 'in' : 'at'} ${event.region}`;
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
  const recent = town.events.slice(-(FEED_LENGTH - (town.day > 1 ? 1 : 0))).reverse();
  return (
    <section className="town panel" aria-label="Residents">
      <div className="panel-heading"><span>Residents</span><span>{town.households.length} homes</span></div>
      <dl className="town-stats">
        <div><dt>people</dt><dd>{totals.population}</dd></div>
        <div><dt>adults employed</dt><dd>{totals.employed}/{totals.adults}</dd></div>
        {town.businesses.length > 0 && <div><dt>local workers</dt><dd>{totals.localWorkers}</dd></div>}
        <div><dt>cross-commuting</dt><dd>{totals.crossCommuters}</dd></div>
        <div><dt>cars</dt><dd>{totals.cars}</dd></div>
        <div><dt>homes upgraded</dt><dd>{upgraded}</dd></div>
        <div><dt>avg. funds</dt><dd>{money(totals.meanFunds)}</dd></div>
      </dl>
      <section className="town-demand" aria-label="Zone demand">
        <h2 className="panel-heading">Demand</h2>
        {ZONE_KINDS.map(zone => <div className="need" key={zone}>
          <span>{zone === 'residential' ? 'Homes' : zone === 'shops' ? 'Shops' : 'Workplaces'}</span>
          <div className="need-bar" role="meter" aria-label={zone + ' demand'} aria-valuemin={0}
            aria-valuemax={100} aria-valuenow={town.demand[zone]}>
            <i style={{ width: town.demand[zone] + '%', background: PALETTE.zonePaint[zone] }} />
          </div>
        </div>)}
      </section>
      {(recent.length > 0 || town.day > 1) && <ol className="town-feed" aria-label="Recent events">
        {town.day > 1 && <li><span>Taxes collected: +{money(town.budget.yesterday.homes + town.budget.yesterday.shops + town.budget.yesterday.workplaces)}</span><time>Midnight</time></li>}
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
    case 'park': return 'Visiting ' + place;
    case 'walking': return person.errand === 'leisure' ? 'Walking on a park visit' : 'Walking';
    case 'searching': return 'Looking for parking';
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
  const model = vehicleType(household.carModel).name;
  return (
    <section className="household panel" aria-label="Household">
      <div className="panel-heading">
        <span>{household.region} · {HOMES[household.level - 1]}</span>
        <button className="close" onClick={onClose} aria-label="Close household" title="Close (Esc)">×</button>
      </div>
      <h2 className="household-name">{family(household)}</h2>
      <p className="household-meta">
        <span><i className="car-swatch" style={{ background: PALETTE.vehicles[vehicleType(household.carModel).colours[0]] }} aria-hidden="true" />{household.cars} {model}{household.cars === 1 ? '' : 's'} · {household.parked.join(', ')}</span>
        <span>{money(household.funds)}</span>
      </p>
      <div className="needs">
        <Need label="Food" value={needs.food} />
        <Need label="Comfort" value={needs.comfort} />
        <Need label="Mobility" value={needs.mobility} />
        <Need label="Security" value={needs.security} />
        <Need label="Happiness" value={household.happiness} />
      </div>
      {household.nearbyPark && <p>{household.nearbyPark.name} · {household.nearbyPark.metres} m on foot{household.nearbyPark.happinessPoints > 0 && <> · Parks add {household.nearbyPark.happinessPoints} happiness points</>}</p>}
      {household.walkIssue && <p>No safe way to walk to {household.walkIssue}.</p>}
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

export function BudgetPanel({ town }: { town: TownView }) {
  const { balance, today, yesterday, history } = town.budget;
  const rows = [
    ['Homes', 'homes'], ['Shops', 'shops'], ['Workplaces', 'workplaces'],
    ['Building', 'building'], ['Road upkeep', 'upkeep'],
  ] as const;
  return <details className="budget panel">
    <summary>Town budget <strong>{money(balance)}</strong></summary>
    <table>
      <thead><tr><th>Cash flow</th><th>Today</th><th>Yesterday</th></tr></thead>
      <tbody>{rows.map(([label, key]) => {
        const sign = key === 'building' || key === 'upkeep' ? -1 : 1;
        return <tr key={key}><th>{label}</th><td>{money(today[key] * sign)}</td>
          <td>{town.day === 1 ? '–' : money(yesterday[key] * sign)}</td></tr>;
      })}</tbody>
    </table>
    <p>Taxes and road upkeep settle at midnight.</p>
    <h3>Closing balances</h3>
    {history.length ? <ol>{history.map((amount, i) => {
      const day = town.day - history.length + i;
      return <li key={day}><span>Day {day}</span><strong>{money(amount)}</strong></li>;
    })}</ol> : <p>First close at midnight</p>}
  </details>;
}
