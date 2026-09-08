// OAuth2 client-credentials tokens for OpenSky.
//
// Tokens last 30 minutes, which sounds like a non-problem until a burst of
// requests arrives at minute 30: without care, every one of them fires its own
// token request. This manager keeps a single token, refreshes it slightly
// before it expires, and collapses concurrent refreshes into one call.
//
// The clock and fetch are injected so all of that is testable as logic, with
// no network and no waiting.

export interface TokenManagerOptions {
  clientId: string;
  clientSecret: string;
  tokenUrl?: string;
  fetchImpl?: typeof fetch;
  /** Milliseconds since epoch. Injected so tests can move time by hand. */
  now?: () => number;
  /** Refresh this long before actual expiry, so a request cannot race it. */
  refreshMarginMs?: number;
}

export const OPENSKY_TOKEN_URL =
  'https://auth.opensky-network.org/auth/realms/opensky-network/protocol/openid-connect/token';

interface CachedToken {
  value: string;
  expiresAt: number;
}

export class TokenManager {
  readonly #clientId: string;
  readonly #clientSecret: string;
  readonly #tokenUrl: string;
  readonly #fetch: typeof fetch;
  readonly #now: () => number;
  readonly #margin: number;

  #cached: CachedToken | null = null;
  /** The refresh currently in flight, shared by every caller that arrives during it. */
  #inFlight: Promise<string> | null = null;

  /** Number of token requests actually sent. Exposed for tests and diagnostics. */
  refreshCount = 0;

  constructor(options: TokenManagerOptions) {
    this.#clientId = options.clientId;
    this.#clientSecret = options.clientSecret;
    this.#tokenUrl = options.tokenUrl ?? OPENSKY_TOKEN_URL;
    // Bound to globalThis on purpose. Stored as a bare reference and then
    // called as `this.#fetch(...)`, the receiver becomes this instance —
    // which Node tolerates and Cloudflare Workers rejects outright with
    // "Illegal invocation".
    this.#fetch = options.fetchImpl ?? globalThis.fetch.bind(globalThis);
    this.#now = options.now ?? Date.now;
    this.#margin = options.refreshMarginMs ?? 60_000;
  }

  /** A token that is valid now, fetching or refreshing one only if necessary. */
  async getToken(): Promise<string> {
    if (this.#cached && this.#now() < this.#cached.expiresAt - this.#margin) {
      return this.#cached.value;
    }
    // Everyone who arrives while a refresh is running waits on that one refresh
    // rather than starting another.
    this.#inFlight ??= this.#refresh().finally(() => { this.#inFlight = null; });
    return this.#inFlight;
  }

  /** Drops the cached token, so the next call fetches a new one. Used after a 401. */
  invalidate(): void {
    this.#cached = null;
  }

  async #refresh(): Promise<string> {
    this.refreshCount++;

    const response = await this.#fetch(this.#tokenUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'client_credentials',
        client_id: this.#clientId,
        client_secret: this.#clientSecret,
      }),
    });

    if (!response.ok) {
      // Leave the cache untouched: a failed refresh must not also discard a
      // token that might still be usable, and the next call will try again.
      throw new Error(`token request failed: ${response.status} ${response.statusText}`);
    }

    const body = await response.json() as { access_token?: string; expires_in?: number };
    if (!body.access_token) throw new Error('token response contained no access_token');

    const lifetimeMs = (body.expires_in ?? 1800) * 1000;
    this.#cached = { value: body.access_token, expiresAt: this.#now() + lifetimeMs };
    return body.access_token;
  }
}
