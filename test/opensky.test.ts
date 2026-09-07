import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fetchSnapshot, creditCost, RateLimitError, STOCKHOLM } from '../src/server/opensky.ts';
import { TokenManager } from '../src/server/token.ts';

const tokenStub = () => new TokenManager({
  clientId: 'id',
  clientSecret: 'secret',
  now: () => 0,
  fetchImpl: (async () => Response.json({ access_token: 'tok', expires_in: 1800 })) as unknown as typeof fetch,
});

const statesBody = {
  time: 1_788_791_605,
  states: [[
    '4aca81', 'NSZ56J  ', 'Sweden', 1_788_791_600, 1_788_791_605, 17.48, 57.84,
    10_035, false, 210, 12, -3.9, null, 10_325, '1000', false, 0,
  ]],
};

const okResponse = (headers: Record<string, string> = {}) =>
  Response.json(statesBody, { headers: { 'x-rate-limit-remaining': '3999', ...headers } });

test('credit cost follows the published bounding-box bands', () => {
  assert.equal(creditCost(STOCKHOLM), 1);
  assert.equal(creditCost({ lamin: 0, lomin: 0, lamax: 5, lomax: 5 }), 1);      // 25 sq°
  assert.equal(creditCost({ lamin: 0, lomin: 0, lamax: 5, lomax: 6 }), 2);      // 30 sq°
  assert.equal(creditCost({ lamin: 55, lomin: 11, lamax: 69, lomax: 24 }), 3);  // Sweden
  assert.equal(creditCost({ lamin: -90, lomin: -180, lamax: 90, lomax: 180 }), 4);
});

test('the Stockholm box stays inside the one-credit band', () => {
  const area = (STOCKHOLM.lamax - STOCKHOLM.lamin) * (STOCKHOLM.lomax - STOCKHOLM.lomin);
  assert.ok(area <= 25, `box is ${area} sq°, which would cost more than one credit`);
});

test('the box is shaped for a landscape screen once projected', () => {
  // A degree of longitude shrinks with latitude, so the box has to be wider in
  // longitude than it looks to come out roughly 16:9 on screen.
  const midLat = (STOCKHOLM.lamin + STOCKHOLM.lamax) / 2;
  const spanLat = STOCKHOLM.lamax - STOCKHOLM.lamin;
  const spanLon = (STOCKHOLM.lomax - STOCKHOLM.lomin) * Math.cos((midLat * Math.PI) / 180);
  const aspect = spanLon / spanLat;
  assert.ok(aspect > 1.5 && aspect < 2.1, `projected aspect is ${aspect.toFixed(2)}:1`);
});

test('a snapshot carries the server clock, the targets and the budget', async () => {
  const snapshot = await fetchSnapshot({
    tokens: tokenStub(),
    fetchImpl: (async () => okResponse()) as unknown as typeof fetch,
  });

  assert.equal(snapshot.time, 1_788_791_605);
  assert.equal(snapshot.targets.length, 1);
  assert.equal(snapshot.targets[0]!.callsign, 'NSZ56J');
  assert.equal(snapshot.targets[0]!.ageAtFetch, 5);
  assert.equal(snapshot.budget.remaining, 3999);
  assert.equal(snapshot.degraded, false);
});

test('the bounding box is sent as query parameters', async () => {
  let seen = '';
  await fetchSnapshot({
    tokens: tokenStub(),
    fetchImpl: (async (url: string) => { seen = String(url); return okResponse(); }) as unknown as typeof fetch,
  });

  // Asserted against the box itself, so widening it is not a test failure.
  assert.match(seen, new RegExp(`lamin=${STOCKHOLM.lamin}`));
  assert.match(seen, new RegExp(`lomax=${STOCKHOLM.lomax}`));
});

test('an expired token is refreshed and the call retried exactly once', async () => {
  let calls = 0;
  const fetchImpl = (async () => {
    calls++;
    return calls === 1
      ? new Response('expired', { status: 401, statusText: 'Unauthorized' })
      : okResponse();
  }) as unknown as typeof fetch;

  const snapshot = await fetchSnapshot({ tokens: tokenStub(), fetchImpl });
  assert.equal(calls, 2);
  assert.equal(snapshot.targets.length, 1);
});

test('a persistent 401 gives up rather than retrying forever', async () => {
  let calls = 0;
  const fetchImpl = (async () => {
    calls++;
    return new Response('no', { status: 401, statusText: 'Unauthorized' });
  }) as unknown as typeof fetch;

  await assert.rejects(() => fetchSnapshot({ tokens: tokenStub(), fetchImpl }), /401/);
  assert.equal(calls, 2, 'one retry, not a loop');
});

test('an exhausted allowance is a typed error carrying the wait', async () => {
  const fetchImpl = (async () => new Response('slow down', {
    status: 429,
    headers: { 'x-rate-limit-retry-after-seconds': '900', 'x-rate-limit-remaining': '0' },
  })) as unknown as typeof fetch;

  await assert.rejects(
    () => fetchSnapshot({ tokens: tokenStub(), fetchImpl }),
    (error: unknown) => {
      assert.ok(error instanceof RateLimitError);
      assert.equal(error.retryAfterSeconds, 900);
      assert.equal(error.budget.remaining, 0);
      return true;
    },
  );
});

test('an empty sky is a valid answer, not a failure', async () => {
  const fetchImpl = (async () => Response.json({ time: 123, states: null })) as unknown as typeof fetch;
  const snapshot = await fetchSnapshot({ tokens: tokenStub(), fetchImpl });
  assert.deepEqual(snapshot.targets, []);
  assert.equal(snapshot.time, 123);
});

test('a missing rate-limit header reads as unknown, not as zero', async () => {
  const fetchImpl = (async () => Response.json(statesBody)) as unknown as typeof fetch;
  const snapshot = await fetchSnapshot({ tokens: tokenStub(), fetchImpl });
  assert.equal(snapshot.budget.remaining, null);
});
