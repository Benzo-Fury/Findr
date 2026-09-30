/**
 * Resolves an IMDb ID to its TMDB records, letting the client attach titles
 * and artwork to jobs and indexes that only store an IMDb ID.
 */

import { factory } from "../../../lib/routing/factory";
import { respond } from "../../../lib/tmdb/respond";
import TMDB from "../../../lib/tmdb/TMDB";

export default factory({
  authenticated: true,
  GET: (ctx) => {
    const imdbId = ctx.req.param("imdbId") as string;

    return respond(ctx, () => TMDB.getInstance().find(imdbId));
  },
});
