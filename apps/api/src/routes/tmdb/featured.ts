/**
 * Trending posters for the login screen backdrop. This is the only TMDB route
 * that stays public, so the page can render before a session exists — the
 * client-side cache keeps the exposure to one upstream call per TTL window.
 */

import { factory } from "../../lib/routing/factory";
import { respond } from "../../lib/tmdb/respond";
import TMDB from "../../lib/tmdb/TMDB";

export default factory({
  authenticated: false,
  GET: (ctx) => respond(ctx, () => TMDB.getInstance().featured()),
});
