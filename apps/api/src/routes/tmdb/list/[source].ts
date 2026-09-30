/**
 * Serves any of the named TMDB lists from the source catalog as a page of
 * poster items — trending, top rated, popular, now playing, and so on.
 *
 * Sources defined over both movies and shows honour the `type` parameter
 * (`movie`, `tv`, or omitted for both); the rest ignore it.
 */

import type { TMDBMediaType } from "@findr/types";
import { factory } from "../../../lib/routing/factory";
import { respond } from "../../../lib/tmdb/respond";
import TMDB from "../../../lib/tmdb/TMDB";
import { isListSource } from "../../../lib/tmdb/sources";

export default factory({
  authenticated: true,
  GET: (ctx) => {
    const source = ctx.req.param("source") as string;

    if (!isListSource(source)) {
      return ctx.json({ error: "unknown_source" }, 404);
    }

    const page = Number(ctx.req.query("page") ?? 1);
    const type = ctx.req.query("type");
    const mediaType: TMDBMediaType | "all" =
      type === "movie" || type === "tv" ? type : "all";

    return respond(ctx, () => TMDB.getInstance().list(source, { page, mediaType }));
  },
});
