// The only endpoint. Written against the Web platform's Request/Response, so
// the same function runs on Vercel, on Cloudflare Workers, or in the local dev
// server without changing a line.
//
// The point of this file is not to proxy a request. It is to make sure that
// however many people are watching, OpenSky is called at most once every few
// seconds — because the daily allowance is 4,000 credits and a per-visitor
// fetch would burn it in minutes.
//
// That is what `s-maxage` does here: the CDN answers every viewer from cache
// and only one request per window reaches this function at all. Ten viewers or
// two hundred cost the same.

// `process` without pulling in @types/node, which would be the project's first
// dependency for the sake of one global.
declare const process: { env: Record<string, string | undefined> };

import { TokenManager } from '../src/server/token.ts';
import { fetchSnapshot, creditCost, RateLimitError, STOCKHOLM } from '../src/server/opensky.ts';

/** Seconds the CDN may serve a snapshot before asking for a new one.
 *  Authenticated data has 5-second resolution, so asking faster buys nothing. */
const CACHE_SECONDS = 8;

export interface Credentials {
  clientId: string | undefined;
  clientSecret: string | undefined;
}

/**
 * Reused across warm invocations so the token survives between requests, and
 * keyed by client id so a credential change cannot be served a stale token.
 */
const tokenManagers = new Map<string, TokenManager>();

function getTokens({ clientId, clientSecret }: Credentials): TokenManager {
  if (!clientId || !clientSecret) {
    throw new Error(
      'OPENSKY_CLIENT_ID and OPENSKY_CLIENT_SECRET must be set. ' +
      'Locally: put them in .env.local. On a host: its environment variables.',
    );
  }

  let manager = tokenManagers.get(clientId);
  if (!manager) {
    manager = new TokenManager({ clientId, clientSecret });
    tokenManagers.set(clientId, manager);
  }
  return manager;
}

/**
 * The endpoint, with its credentials passed in rather than read from a global.
 *
 * Hosts disagree about where configuration lives — `process.env` on Vercel and
 * Node, a binding argument on Cloudflare Workers — so the handler takes them as
 * an argument and each host's entry point supplies them. It also makes this
 * testable without touching the environment.
 */
export async function handleStates(credentials: Credentials): Promise<Response> {
  try {
    const snapshot = await fetchSnapshot({ tokens: getTokens(credentials), box: STOCKHOLM });

    return Response.json(
      { ...snapshot, cost: creditCost(STOCKHOLM) },
      {
        headers: {
          // Shared cache holds it; the browser always revalidates, so a viewer
          // who leaves a tab open overnight is not shown last night's sky.
          'cache-control': `public, max-age=0, s-maxage=${CACHE_SECONDS}, stale-while-revalidate=30`,
          'access-control-allow-origin': '*',
        },
      },
    );
  } catch (error) {
    // Nothing is cached on failure. The display keeps its own last good
    // snapshot and marks it as ageing — which is more honest than this
    // function inventing one, and is exactly what the freshness bands are for.
    const rateLimited = error instanceof RateLimitError;

    // `fetch failed` on its own is useless: undici puts the real reason —
    // DNS, TLS, connection refused — in `cause`. Unwrap it, log it, and say it.
    // A proxy that swallows why it broke is the failure this project is about.
    const cause = error instanceof Error && error.cause instanceof Error
      ? ` (${error.cause.name}: ${error.cause.message})`
      : '';
    console.error('states endpoint failed:', error);

    return Response.json(
      {
        error: rateLimited ? 'rate_limited' : 'upstream_unavailable',
        message: (error instanceof Error ? error.message : 'unknown error') + cause,
        retryAfter: rateLimited ? error.retryAfterSeconds : null,
      },
      {
        status: rateLimited ? 429 : 503,
        headers: {
          'cache-control': 'no-store',
          'access-control-allow-origin': '*',
          ...(rateLimited ? { 'retry-after': String(error.retryAfterSeconds) } : {}),
        },
      },
    );
  }
}

/**
 * Vercel and the local dev server: a named HTTP method, not a default export.
 * A default export is read as the Node `(req, res) => void` signature, where a
 * returned Response is ignored and the request hangs until it times out —
 * which is exactly what happened the first time this was deployed.
 */
export async function GET(_request: Request): Promise<Response> {
  return handleStates({
    clientId: process.env.OPENSKY_CLIENT_ID,
    clientSecret: process.env.OPENSKY_CLIENT_SECRET,
  });
}
