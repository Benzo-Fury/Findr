/**
 * One page of titles in a genre, ordered by popularity, rating or recency.
 * Backs the discover page's genre view and its infinite scroll.
 */

import { BrowseQuerySchema } from "@findr/types/tmdb";
import { factory } from "../../lib/routing/factory";
import { queryOf } from "../../lib/routing/input";
import { respond } from "../../lib/tmdb/respond";
import TMDB from "../../lib/tmdb/TMDB";

export default factory({
  GET: {
    query: BrowseQuerySchema,
    handler: (ctx) => respond(ctx, () => TMDB.getInstance().browse(queryOf(ctx, BrowseQuerySchema))),
  },
});
