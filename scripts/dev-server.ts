// Local development server.
//
// It mounts the same handler that Vercel will run, so what you test here is
// what ships. The one thing it cannot reproduce is the CDN: in production a
// shared cache absorbs every viewer and only one request per window reaches
// the function, whereas here every reload is a real call to OpenSky and a real
// credit spent. The console prints the running total so that stays visible.
//
//   node --env-file=.env.local scripts/dev-server.ts

import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, normalize, join } from 'node:path';
import handler from '../api/states.ts';

const PORT = Number(process.env.PORT ?? 8787);
const PUBLIC_DIR = new URL('../public/', import.meta.url);

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.json': 'application/json',
};

let callsThisSession = 0;

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', `http://localhost:${PORT}`);

  if (url.pathname === '/api/states') {
    callsThisSession++;
    const response = await handler(new Request(url, { method: req.method }));
    const body = await response.text();

    const remaining = (() => {
      try { return JSON.parse(body).budget?.remaining ?? null; } catch { return null; }
    })();
    console.log(
      `${response.status} /api/states  · call #${callsThisSession} this session` +
      (remaining === null ? '' : `  · ${remaining} credits left today`),
    );

    res.writeHead(response.status, Object.fromEntries(response.headers));
    res.end(body);
    return;
  }

  // Everything else is the display itself, served flat out of public/.
  const requested = url.pathname === '/' ? '/index.html' : url.pathname;
  // normalize + a leading-dot check keeps ../ out of the served path.
  const safe = normalize(requested).replace(/^(\.\.[/\\])+/, '');
  try {
    const file = await readFile(new URL(`.${safe}`, PUBLIC_DIR));
    res.writeHead(200, { 'content-type': MIME[extname(safe)] ?? 'application/octet-stream' });
    res.end(file);
  } catch {
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('not found');
  }
});

server.listen(PORT, () => {
  const configured = process.env.OPENSKY_CLIENT_ID && process.env.OPENSKY_CLIENT_SECRET;
  console.log(`final-approach dev server → http://localhost:${PORT}`);
  console.log(`  data endpoint            → http://localhost:${PORT}/api/states`);
  console.log(configured
    ? '  credentials              → loaded'
    : '  credentials              → MISSING: run with --env-file=.env.local');
  console.log('\nEvery reload of /api/states spends one credit of the 4,000 daily.\n');
});
