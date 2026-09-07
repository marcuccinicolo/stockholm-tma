// One-off sanity check: pull the live Arlanda box anonymously and run it
// through the core, to see what the display will actually have to cope with.
import { parseStateVector, project, isDisplayable, type StateVector } from '../src/core/target.ts';

const BOX = { lamin: 59.0, lomin: 17.0, lamax: 60.3, lomax: 19.0 };
const url = `https://opensky-network.org/api/states/all?${new URLSearchParams(
  Object.entries(BOX).map(([k, v]) => [k, String(v)]))}`;

const res = await fetch(url);
console.log('HTTP', res.status, '| credits left:', res.headers.get('x-rate-limit-remaining'));

const body = await res.json() as { time: number; states: StateVector[] | null };
const targets = (body.states ?? []).map(row => parseStateVector(row, body.time));

const count = (fn: (t: ReturnType<typeof parseStateVector>) => boolean) => targets.filter(fn).length;
const drawn = targets.map(t => project(t, 0));

console.log(`\naircraft in the box: ${targets.length}`);
console.log(`  displayable now:   ${drawn.filter(isDisplayable).length}`);
console.log(`  on the ground:     ${count(t => t.onGround)}`);
console.log(`  no position:       ${count(t => t.position === null)}`);
console.log(`  no velocity/track: ${count(t => t.velocity === null || t.track === null)}`);

const tally = (xs: string[]) => [...xs.reduce((m, x) => m.set(x, (m.get(x) ?? 0) + 1), new Map())]
  .sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k}=${v}`).join('  ');

console.log(`\nfreshness: ${tally(drawn.map(d => d.freshness))}`);
console.log(`sources:   ${tally(targets.map(t => t.source))}`);

const ages = targets.map(t => t.ageAtFetch).sort((a, b) => a - b);
if (ages.length) {
  console.log(`ages (s):  min ${ages[0]}  median ${ages[ages.length >> 1]}  max ${ages.at(-1)}`);
}

console.log('\nfurthest a target moves in 5 s of dead reckoning:');
const moves = targets
  .map(t => ({ t, p: project(t, 5) }))
  .filter(x => x.p.estimated && x.t.velocity !== null)
  .sort((a, b) => b.t.velocity! - a.t.velocity!)
  .slice(0, 3);
for (const { t } of moves) {
  console.log(`  ${(t.callsign ?? t.icao24).padEnd(9)} ${Math.round(t.velocity! * 5)} m at ${Math.round(t.velocity!)} m/s`);
}
