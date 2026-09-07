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

import { TokenManager } from '../src/server/token.ts';
import { fetchSnapshot, creditCost, RateLimitError, STOCKHOLM } from '../src/server/opensky.ts';

/** Seconds the CDN may serve a snapshot before asking for a new one.
 *  Authenticated data has 5-second resolution, so asking faster buys nothing. */
const CACHE_SECONDS = 8;

/** Reused across warm invocations, so the token survives between requests. */
let tokens: TokenManager | null = null;

function getTokens(): TokenManager {
  const clientId = process.env.OPENSKY_CLIENT_ID;
  const clientSecret = process.env.OPENSKY_CLIENT_SECRET;

  if (!clientId || !clientSecret) {
    throw new Error(
      'OPENSKY_CLIENT_ID and OPENSKY_CLIENT_SECRET must be set. ' +
      'Locally: put them in .env.local. On Vercel: project settings, environment variables.',
    );
  }

  tokens ??= new TokenManager({ clientId, clientSecret });
  return tokens;
}

export default async function handler(_request: Request): Promise<Response> {
  try {
    const snapshot = await fetchSnapshot({ tokens: getTokens(), box: STOCKHOLM });

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

    return Response.json(
      {
        error: rateLimited ? 'rate_limited' : 'upstream_unavailable',
        message: error instanceof Error ? error.message : 'unknown error',
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
