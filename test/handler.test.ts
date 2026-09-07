import { test } from 'node:test';
import assert from 'node:assert/strict';
import { handleStates } from '../api/states.ts';

// The handler took its credentials from `process.env` until Cloudflare needed
// them as an argument. Passing them in is what makes this testable at all.
test('missing credentials give 503 and say what to set, without calling out', async () => {
  const response = await handleStates({ clientId: undefined, clientSecret: undefined });
  assert.equal(response.status, 503);
  assert.equal(response.headers.get('cache-control'), 'no-store');

  const body = await response.json() as { error: string; message: string };
  assert.equal(body.error, 'upstream_unavailable');
  assert.match(body.message, /OPENSKY_CLIENT_ID/);
});

test('an incomplete pair is still a missing configuration', async () => {
  const response = await handleStates({ clientId: 'id', clientSecret: undefined });
  assert.equal(response.status, 503);
});
