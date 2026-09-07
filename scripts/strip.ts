// Serving the core to the browser without a build tool.
//
// The projection maths must be identical in the tests and on screen — the
// moment they are two copies, one of them starts drifting. So the browser
// imports the same files, with the types removed by Node's own stripper and
// the `.ts` specifiers rewritten to `.js` so a browser will resolve them.
//
// Used by both the dev server (on the fly) and the production build.

import { stripTypeScriptTypes } from 'node:module';
import { readFile, writeFile, mkdir, readdir } from 'node:fs/promises';

const CORE_DIR = new URL('../src/core/', import.meta.url);

/** Strips one core module to browser-ready JavaScript. */
export async function stripModule(name: string): Promise<string> {
  const source = await readFile(new URL(name, CORE_DIR), 'utf8');
  const js = stripTypeScriptTypes(source, { mode: 'strip' });
  // Type-only imports strip to bare `import './geo.ts';` or vanish entirely;
  // whatever survives must point at a path the browser can fetch.
  return js.replace(/(\bfrom\s+['"]\.\/[^'"]+)\.ts(['"])/g, '$1.js$2');
}

export async function coreModules(): Promise<string[]> {
  return (await readdir(CORE_DIR)).filter(f => f.endsWith('.ts'));
}

/** Writes the stripped core into public/core/ for deployment. */
export async function buildCore(): Promise<string[]> {
  const outDir = new URL('../public/core/', import.meta.url);
  await mkdir(outDir, { recursive: true });

  const written: string[] = [];
  for (const name of await coreModules()) {
    const out = name.replace(/\.ts$/, '.js');
    await writeFile(new URL(out, outDir), await stripModule(name));
    written.push(out);
  }
  return written;
}

if (import.meta.filename === process.argv[1]) {
  const written = await buildCore();
  console.log(`core → public/core/: ${written.join(', ')}`);
}
