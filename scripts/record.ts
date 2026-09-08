// Records real traffic so the public demo can replay it.
//
// OpenSky is unreachable from data centres — verified from two Vercel regions
// and from Cloudflare Workers, while a home connection reaches it in under
// fifty milliseconds. So the deployed display cannot call it live. Rather than
// fake the data, it replays a recording of the real thing, and says so.
//
//   node --env-file=.env.local scripts/record.ts [minutes]
//
// One credit per snapshot, out of 4,000 a day.

import { writeFile } from 'node:fs/promises';
import { TokenManager } from '../src/server/token.ts';
import { fetchSnapshot, creditCost } from '../src/server/opensky.ts';
import { STOCKHOLM } from '../src/core/box.ts';
import type { StateVector } from '../src/core/target.ts';

declare const process: { env: Record<string, string | undefined>; argv: string[] };

const MINUTES = Number(process.argv[2] ?? 5);
const INTERVAL_MS = 8000;
const OUT = new URL('../public/data/replay.json', import.meta.url);

const clientId = process.env.OPENSKY_CLIENT_ID;
const clientSecret = process.env.OPENSKY_CLIENT_SECRET;
if (!clientId || !clientSecret) {
  throw new Error('run with --env-file=.env.local');
}

const tokens = new TokenManager({ clientId, clientSecret });
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

/**
 * Trims a state vector to what the display reads, at the precision it can show.
 * Four decimals of latitude is about 11 m — far below one pixel at this scale —
 * and the raw feed carries far more digits than that.
 */
function compact(row: StateVector): StateVector {
  const round = (v: number | null, places: number) =>
    v === null ? null : Number(v.toFixed(places));

  const out = [...row] as StateVector;
  out[5] = round(out[5], 4);   // longitude
  out[6] = round(out[6], 4);   // latitude
  out[7] = round(out[7], 1);   // barometric altitude
  out[9] = round(out[9], 1);   // velocity
  out[10] = round(out[10], 1); // true track
  out[11] = round(out[11], 2); // vertical rate
  out[12] = null;              // sensors: always null here, never read
  out[13] = round(out[13], 1); // geometric altitude
  return out;
}

const snapshots: { time: number; states: StateVector[] }[] = [];
const wanted = Math.max(1, Math.round((MINUTES * 60_000) / INTERVAL_MS));

console.log(`recording ${MINUTES} min — ${wanted} snapshots, ${wanted * creditCost(STOCKHOLM)} credits\n`);

for (let i = 0; i < wanted; i++) {
  const started = Date.now();
  try {
    const snapshot = await fetchSnapshot({ tokens, box: STOCKHOLM });
    // Re-fetching raw rows would mean a second call, so the compacted vectors
    // are rebuilt from the parsed targets' own source: the untouched response.
    snapshots.push({ time: snapshot.time, states: snapshot.raw.map(compact) });
    console.log(
      `  ${String(i + 1).padStart(3)}/${wanted}  ${snapshot.targets.length} aircraft` +
      `  ${snapshot.budget.remaining ?? '?'} credits left`,
    );
  } catch (error) {
    console.warn(`  ${i + 1}/${wanted}  failed: ${(error as Error).message}`);
  }
  const wait = INTERVAL_MS - (Date.now() - started);
  if (i < wanted - 1 && wait > 0) await sleep(wait);
}

if (snapshots.length < 2) throw new Error('too few snapshots recorded to replay');

const span = snapshots.at(-1)!.time - snapshots[0]!.time;
await writeFile(OUT, JSON.stringify({
  note: 'Real traffic recorded from the OpenSky Network. Replayed because OpenSky is not reachable from data centres.',
  recordedAt: new Date(snapshots[0]!.time * 1000).toISOString(),
  box: STOCKHOLM,
  snapshots,
}));

console.log(`\nwrote ${snapshots.length} snapshots spanning ${Math.round(span)} s`);
