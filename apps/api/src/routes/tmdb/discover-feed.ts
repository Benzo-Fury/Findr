/**
 * Returns the pre-composed discover page — several curated rows of poster
 * items built from a fan-out of TMDB list endpoints and served from cache.
 */

import { factory } from "../../lib/routing/factory";
import { respond } from "../../lib/tmdb/respond";
import TMDB from "../../lib/tmdb/TMDB";

export default factory({
  authenticated: true,
  GET: (ctx) => respond(ctx, () => TMDB.getInstance().discoverFeed()),
});
