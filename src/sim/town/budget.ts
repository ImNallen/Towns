import { ROAD_TYPES } from '../network/roadTypes';
import { polyline } from '../math/polyline';
import { isZoneStroke, meadowSegmentInfo, type MeadowEdit } from '../scenarios/meadow';

import { BUDGET } from './economy';

/** Signed cost in whole dollars, based on the geometry before the edit. */
export function editCost(previous: readonly MeadowEdit[], edit: MeadowEdit): number {
  if (isZoneStroke(edit)) return edit.zone ? edit.cells.length * (edit.zone === 'parking' ? BUDGET.parkingPerCell : BUDGET.zonePerCell) : 0;
  if ('remove' in edit || 'upgrade' in edit) {
    const segment = meadowSegmentInfo(previous)['remove' in edit ? edit.remove : edit.upgrade]!;
    const before = ROAD_TYPES[segment.roadType].cost;
    const after = 'remove' in edit ? 0 : ROAD_TYPES[edit.roadType].cost;
    const delta = (segment.to - segment.from) * (after - before);
    return delta < 0 ? -Math.round(-delta * BUDGET.salvageShare) : Math.round(delta);
  }
  return Math.round(polyline(edit.points).length * ROAD_TYPES[edit.roadType ?? 'town'].cost);
}

/** Undo uses the same pre-edit geometry that determined the original invoice. */
export function undoCost(edits: readonly MeadowEdit[]): number {
  const last = edits.at(-1);
  return last ? -editCost(edits.slice(0, -1), last) : 0;
}

export const dollars = (n: number): string => (n < 0 ? '−$' : '$') + Math.abs(Math.round(n)).toLocaleString('en-US');

export function shortage(balance: number, cost: number): string | undefined {
  if (cost > 0 && cost > balance) return `Costs ${dollars(cost)}, you have ${dollars(balance)}`;
}

const emptyDay = () => ({ homes: 0, shops: 0, workplaces: 0, building: 0, upkeep: 0 });
export type BudgetDay = ReturnType<typeof emptyDay>;
export type BudgetView = ReturnType<Treasury['view']>;

export class Treasury {
  balance: number = BUDGET.startingBalance;
  readonly today = emptyDay();
  readonly yesterday = emptyDay();
  private readonly closing = new Float64Array(7);
  private days = 0;

  book(cost: number): string | undefined {
    const reason = shortage(this.balance, cost);
    if (reason) return reason;
    this.balance -= cost;
    this.today.building += cost;
    return undefined;
  }

  close(roadMetres: number, upkeep = Math.round(roadMetres * BUDGET.upkeepPerMetre)): void {
    const day = this.today;
    day.upkeep = upkeep;
    this.balance += day.homes + day.shops + day.workplaces - day.upkeep;
    Object.assign(this.yesterday, day);
    day.building = day.homes = day.shops = day.workplaces = day.upkeep = 0;
    this.closing[this.days++ % 7] = this.balance;
  }

  copyFrom(source: Treasury): void {
    this.balance = source.balance;
    this.days = source.days;
    this.closing.set(source.closing);
    Object.assign(this.today, source.today);
    Object.assign(this.yesterday, source.yesterday);
  }

  hash(mix: (n: number) => void): void {
    mix(this.balance);
    mix(this.days);
    this.closing.forEach(mix);
    Object.values(this.today).forEach(mix);
    Object.values(this.yesterday).forEach(mix);
  }

  view() {
    const history: number[] = [];
    for (let i = Math.max(0, this.days - 7); i < this.days; i++) history.push(this.closing[i % 7]!);
    return { balance: this.balance, today: { ...this.today }, yesterday: { ...this.yesterday }, history };
  }
}
