import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { stripModule, coreModules } from '../scripts/strip.ts';

// public/core/*.js is generated from src/core/*.ts and committed, so the
// deployment needs no build step. Committed generated code is only safe if it
// cannot drift, so this asserts it is exactly what the stripper produces now.
// Run `node scripts/strip.ts` to fix a failure here.
test('the browser copy of the core matches its source', async () => {
  for (const name of await coreModules()) {
    const built = new URL(`../public/core/${name.replace(/\.ts$/, '.js')}`, import.meta.url);
    const committed = await readFile(built, 'utf8').catch(() => null);

    assert.ok(committed !== null, `public/core/${name} is missing — run: node scripts/strip.ts`);
    assert.equal(committed, await stripModule(name),
      `public/core/${name} is stale — run: node scripts/strip.ts`);
  }
});
