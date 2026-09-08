// The one place that talks to OpenSky.
//
// It answers a single question — what is in this box right now — and it answers
// it in a way the display can trust: every response says how old its data is,
// how much of the daily budget is left, and whether what you are holding is
// live or the last thing that worked.

import { parseStateVector, type StateVector, type Target } from '../core/target.ts';
import type { TokenManager } from './token.ts';

// The box and its cost live in core, because the browser needs them too.
export { STOCKHOLM, creditCost, type BoundingBox } from '../core/box.ts';
import { STOCKHOLM, type BoundingBox } from '../core/box.ts';

export interface Budget {
  /** Credits left in today's allowance, as reported by OpenSky. Null if absent. */
  remaining: number | null;
  /** Seconds to wait, present only when the allowance is exhausted. */
  retryAfter: number | null;
}

export interface Snapshot {
  /** OpenSky's own clock for this response. Every age on the display derives from it. */
  time: number;
  targets: Target[];
  /**
   * The untouched rows behind `targets`. Kept so a recording can be written
   * from the same response the display was served, rather than costing a
   * second call for the same data.
   */
  raw: StateVector[];
  budget: Budget;
}

// There is deliberately no `degraded` flag here. Whether the display is showing
// live data or the last thing that worked is the display's own state, not a
// property of a snapshot that by definition succeeded.

const readBudget = (headers: Headers): Budget => {
  const remaining = headers.get('x-rate-limit-remaining');
  const retryAfter = headers.get('x-rate-limit-retry-after-seconds');
  return {
    remaining: remaining === null ? null : Number(remaining),
    retryAfter: retryAfter === null ? null : Number(retryAfter),
  };
};

export interface FetchOptions {
  tokens: TokenManager;
  box?: BoundingBox;
  fetchImpl?: typeof fetch;
  baseUrl?: string;
}

/**
 * One authenticated read of the box.
 *
 * A 401 is retried exactly once with a fresh token: tokens expire on a clock we
 * do not control, and a single retry is the difference between a blip and a
 * blank screen. Anything else is thrown for the caller to turn into a degraded
 * response — this function does not decide what the display should show.
 */
export async function fetchSnapshot(options: FetchOptions): Promise<Snapshot> {
  const {
    tokens,
    box = STOCKHOLM,
    fetchImpl = globalThis.fetch.bind(globalThis),
    baseUrl = 'https://opensky-network.org/api',
  } = options;

  const url = `${baseUrl}/states/all?${new URLSearchParams(
    Object.entries(box).map(([k, v]) => [k, String(v)]),
  )}`;

  const call = async (token: string) =>
    fetchImpl(url, { headers: { authorization: `Bearer ${token}` } });

  let response = await call(await tokens.getToken());

  if (response.status === 401) {
    tokens.invalidate();
    response = await call(await tokens.getToken());
  }

  if (response.status === 429) {
    const budget = readBudget(response.headers);
    throw new RateLimitError(budget.retryAfter ?? 60, budget);
  }

  if (!response.ok) {
    throw new Error(`OpenSky returned ${response.status} ${response.statusText}`);
  }

  const body = await response.json() as { time: number; states: StateVector[] | null };

  return {
    time: body.time,
    targets: (body.states ?? []).map(row => parseStateVector(row, body.time)),
    raw: body.states ?? [],
    budget: readBudget(response.headers),
  };
}

export class RateLimitError extends Error {
  // Fields are declared and assigned explicitly rather than written as
  // constructor parameter properties: Node strips types, it does not compile
  // them, and a parameter property would need code to be generated.
  readonly retryAfterSeconds: number;
  readonly budget: Budget;

  constructor(retryAfterSeconds: number, budget: Budget) {
    super(`daily credit allowance exhausted; retry in ${retryAfterSeconds}s`);
    this.name = 'RateLimitError';
    this.retryAfterSeconds = retryAfterSeconds;
    this.budget = budget;
  }
}
