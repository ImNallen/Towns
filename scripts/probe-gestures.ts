import { meadowLayout, planMeadowRoad, snapToMeadowStreet, type MeadowEdit } from '../src/sim/scenarios/meadow';
import type { Vec2 } from '../src/sim/math/vec';

const SNAP = 6;
type Gesture = { name: string; start: Vec2; end: Vec2; bend?: Vec2 };

function attempt(edits: MeadowEdit[], g: Gesture): { edits: MeadowEdit[]; ok: boolean; reason?: string } {
  const { streets } = meadowLayout(edits);
  const start = snapToMeadowStreet(streets, g.start, SNAP)?.point ?? g.start;
  const end = snapToMeadowStreet(streets, g.end, SNAP)?.point ?? g.end;
  const plan = planMeadowRoad(edits, start, end, g.bend);
  return plan.ok ? { edits: [...edits, plan.road], ok: true } : { edits, ok: false, reason: plan.reason };
}

function run(title: string, gestures: Gesture[], base: MeadowEdit[] = []): MeadowEdit[] {
  let edits = base;
  let ok = 0;
  console.log(`\n## ${title}`);
  for (const g of gestures) {
    const r = attempt(edits, g);
    edits = r.edits;
    if (r.ok) ok++;
    console.log(`${r.ok ? 'ok  ' : 'FAIL'} ${g.name}${r.reason ? `: ${r.reason}` : ''}`);
  }
  console.log(`${ok}/${gestures.length} accepted`);
  return edits;
}

const p = (x: number, y: number): Vec2 => ({ x, y });
const connected = run('connect', [{ name: 'tip to tip', start: p(-45, -8), end: p(45, 8) }]);

run('free roads', [
  { name: 'free road in empty land', start: p(-40, 60), end: p(40, 60) },
  { name: 'road from empty land ending on street side', start: p(0, 60), end: p(0, 0) },
], connected);

run('dead-end turns', [
  { name: 'branch north', start: p(-60, -8), end: p(-60, 40) },
  { name: 'turn 90° east at the dead end', start: p(-60, 40), end: p(-20, 40) },
  { name: 'turn 45° at the dead end', start: p(-20, 40), end: p(10, 70) },
  { name: 'U-turn back', start: p(10, 70), end: p(-30, 70) },
], connected);

run('grid district', [
  { name: 'avenue north at x=-40', start: p(-40, -6), end: p(-40, 90) },
  { name: 'avenue north at x=20', start: p(20, 4), end: p(20, 90) },
  { name: 'cross street y=40 joining avenues', start: p(-40, 40), end: p(20, 40) },
  { name: 'cross street y=90 joining tips', start: p(-40, 90), end: p(20, 90) },
  { name: 'cross street y=65 straight through both', start: p(-60, 65), end: p(40, 65) },
  { name: 'avenue x=-10 crossing three streets', start: p(-10, -2), end: p(-10, 100) },
], connected);

run('shallow and diagonal', [
  { name: 'diagonal 30° off street', start: p(-60, -8), end: p(0, 30) },
  { name: 'cross street at 30°', start: p(-40, -40), end: p(20, 40) },
  { name: 'long gentle arc via bend', start: p(-60, -6), end: p(60, 8), bend: p(0, 70) },
], connected);

run('loops', [
  { name: 'loop out and back', start: p(-70, -8), end: p(-20, -4), bend: p(-45, -70) },
  { name: 'short ring road', start: p(20, 4), end: p(70, 8), bend: p(45, -80) },
], connected);

run('curve tool from the street', [
  { name: 'wide loop south', start: p(-75, -8), end: p(-15, -3), bend: p(-45, -90) },
  { name: 'wide arc north', start: p(-60, -6), end: p(40, 7), bend: p(-10, 80) },
  { name: 'bend off a branch end', start: p(10, 6), end: p(60, 60), bend: p(20, 50) },
  { name: 's-curve out into the field', start: p(-30, -6), end: p(30, 90), bend: p(-20, 50) },
], connected);
