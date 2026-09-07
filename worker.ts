// Cloudflare Workers entry point.
//
// It exists because Vercel's egress cannot reach OpenSky: connections to
// auth.opensky-network.org timed out after ten seconds from both Washington and
// Stockholm, while the same host answers a home connection in under fifty
// milliseconds. OpenSky is a free academic service, and filtering cloud ranges
// is an ordinary defence for one.
//
// All this file does is hand the shared handler the credentials, which on
// Workers arrive as a binding argument rather than on `process.env`.

import { handleStates } from './api/states.ts';

interface Env {
  OPENSKY_CLIENT_ID?: string;
  OPENSKY_CLIENT_SECRET?: string;
}

export default {
  async fetch(_request: Request, env: Env): Promise<Response> {
    return handleStates({
      clientId: env.OPENSKY_CLIENT_ID,
      clientSecret: env.OPENSKY_CLIENT_SECRET,
    });
  },
};
