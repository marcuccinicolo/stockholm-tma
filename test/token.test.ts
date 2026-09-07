import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TokenManager } from '../src/server/token.ts';

/** A fetch stand-in that counts calls and can be told to fail or stall. */
function stubFetch(options: { expiresIn?: number; fail?: boolean } = {}) {
  let resolveNext: (() => void) | null = null;
  const calls: string[] = [];

  const impl = (async (_url: string | URL | Request) => {
    calls.push(String(_url));
    if (resolveNext) await new Promise<void>(r => { resolveNext = r; });
    if (options.fail) {
      return new Response('nope', { status: 401, statusText: 'Unauthorized' });
    }
    return Response.json({
      access_token: `token-${calls.length}`,
      expires_in: options.expiresIn ?? 1800,
    });
  }) as unknown as typeof fetch;

  return {
    impl,
    get count() { return calls.length; },
    /** Makes the next refresh hang until released, so overlap can be tested. */
    stall() { resolveNext = () => {}; },
    release() { const r = resolveNext; resolveNext = null; r?.(); },
  };
}

const manager = (fetchImpl: typeof fetch, now: () => number, opts = {}) =>
  new TokenManager({ clientId: 'id', clientSecret: 'secret', fetchImpl, now, ...opts });

test('the first call fetches a token, the second reuses it', async () => {
  const stub = stubFetch();
  let clock = 0;
  const tokens = manager(stub.impl, () => clock);

  assert.equal(await tokens.getToken(), 'token-1');
  clock += 60_000;
  assert.equal(await tokens.getToken(), 'token-1');
  assert.equal(stub.count, 1);
});

test('a token is refreshed once it passes its expiry', async () => {
  const stub = stubFetch({ expiresIn: 1800 });
  let clock = 0;
  const tokens = manager(stub.impl, () => clock);

  await tokens.getToken();
  clock += 1800 * 1000 + 1;
  assert.equal(await tokens.getToken(), 'token-2');
  assert.equal(stub.count, 2);
});

test('a token is refreshed early, inside the safety margin', async () => {
  const stub = stubFetch({ expiresIn: 1800 });
  let clock = 0;
  const tokens = manager(stub.impl, () => clock, { refreshMarginMs: 60_000 });

  await tokens.getToken();
  // 30 s before expiry: still valid, but inside the margin, so it must renew
  // rather than hand out a token that could die mid-request.
  clock += (1800 - 30) * 1000;
  assert.equal(await tokens.getToken(), 'token-2');
  assert.equal(stub.count, 2);
});

test('concurrent callers share a single refresh', async () => {
  const stub = stubFetch();
  const tokens = manager(stub.impl, () => 0);

  stub.stall();
  const waiting = Promise.all([tokens.getToken(), tokens.getToken(), tokens.getToken()]);
  await Promise.resolve();
  stub.release();

  const results = await waiting;
  assert.deepEqual(results, ['token-1', 'token-1', 'token-1']);
  assert.equal(stub.count, 1, 'three callers must not produce three token requests');
  assert.equal(tokens.refreshCount, 1);
});

test('a failed refresh throws and is retried on the next call', async () => {
  let failing = true;
  let calls = 0;
  const impl = (async () => {
    calls++;
    return failing
      ? new Response('no', { status: 503, statusText: 'Service Unavailable' })
      : Response.json({ access_token: 'recovered', expires_in: 1800 });
  }) as unknown as typeof fetch;

  const tokens = manager(impl, () => 0);

  await assert.rejects(() => tokens.getToken(), /token request failed: 503/);
  failing = false;
  assert.equal(await tokens.getToken(), 'recovered');
  assert.equal(calls, 2, 'a failure must not be cached as if it were a token');
});

test('a response without an access_token is an error, not an empty token', async () => {
  const impl = (async () => Response.json({ expires_in: 1800 })) as unknown as typeof fetch;
  await assert.rejects(() => manager(impl, () => 0).getToken(), /no access_token/);
});

test('invalidate forces the next call to fetch again', async () => {
  const stub = stubFetch();
  const tokens = manager(stub.impl, () => 0);

  assert.equal(await tokens.getToken(), 'token-1');
  tokens.invalidate();
  assert.equal(await tokens.getToken(), 'token-2');
  assert.equal(stub.count, 2);
});
