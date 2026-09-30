/**
 * Multi-search proxy backing the search dialog. Results come back in the same
 * poster-item shape as the list endpoints, so the dialog and the grids render
 * from one type.
 */

import { factory } from "../../lib/routing/factory";
import { respond } from "../../lib/tmdb/respond";
import TMDB from "../../lib/tmdb/TMDB";

export default factory({
  authenticated: true,
  GET: (ctx) => {
    const query = ctx.req.query("q")?.trim();

    if (!query) {
      return ctx.json({ error: "missing_query" }, 400);
    }

    return respond(ctx, () => TMDB.getInstance().search(query));
  },
});
