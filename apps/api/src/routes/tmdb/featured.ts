/**
 * Trending posters for the login screen backdrop. This is the only TMDB route
 * that stays public, so the page can render before a session exists. The
 * server-side cache keeps upstream exposure to one TMDB call per TTL window,
 * and the strict public rate limit keeps anonymous clients from hammering it.
 */

import { factory, PUBLIC_RATE_LIMIT } from "../../lib/routing/factory";
import { respond } from "../../lib/tmdb/respond";
import TMDB from "../../lib/tmdb/TMDB";

export default factory({
  authenticated: false,
  rateLimit: PUBLIC_RATE_LIMIT,
  GET: (ctx) => respond(ctx, () => TMDB.getInstance().featured()),
});
