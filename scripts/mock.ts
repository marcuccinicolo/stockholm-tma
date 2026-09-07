// Replays the recorded fixture as if it were arriving now.
//
// Every timestamp is shifted by the same amount, so the relative ages survive:
// the aircraft that was 8 minutes stale when this was recorded is still 8
// minutes stale here. A mock that made everything fresh would hide the exact
// case the display exists to handle.

import { readFile } from 'node:fs/promises';
import { parseStateVector, type StateVector } from '../src/core/target.ts';
import { creditCost, STOCKHOLM } from '../src/server/opensky.ts';

const FIXTURE = new URL('../test/fixtures/snapshot.json', import.meta.url);

export async function mockSnapshot() {
  const raw = JSON.parse(await readFile(FIXTURE, 'utf8')) as {
    time: number; states: StateVector[] | null;
  };

  const now = Math.floor(Date.now() / 1000);
  const shift = now - raw.time;

  const states = (raw.states ?? []).map(row => {
    const shifted = [...row] as StateVector;
    if (shifted[3] !== null) shifted[3] += shift;   // time_position
    shifted[4] += shift;                            // last_contact
    return shifted;
  });

  return {
    time: now,
    targets: states.map(row => parseStateVector(row, now)),
    budget: { remaining: null, retryAfter: null },
    degraded: false,
    mock: true,
    cost: creditCost(STOCKHOLM),
  };
}
