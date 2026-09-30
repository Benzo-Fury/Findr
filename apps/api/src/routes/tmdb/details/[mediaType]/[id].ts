/**
 * Full details for a single title, with videos, credits, recommendations, and
 * external IDs appended. Backs the media detail dialog.
 */

import { factory } from "../../../../lib/routing/factory";
import { respond } from "../../../../lib/tmdb/respond";
import TMDB from "../../../../lib/tmdb/TMDB";

export default factory({
  authenticated: true,
  GET: (ctx) => {
    const mediaType = ctx.req.param("mediaType");
    const id = Number(ctx.req.param("id"));

    if (mediaType !== "movie" && mediaType !== "tv") {
      return ctx.json({ error: "invalid_media_type" }, 400);
    }

    if (!Number.isInteger(id) || id <= 0) {
      return ctx.json({ error: "invalid_id" }, 400);
    }

    return respond(ctx, () => TMDB.getInstance().details(mediaType, id));
  },
});
