/**
 * Title cards for a batch of TMDB identities — names, artwork and genres —
 * so the library can show and search every title it holds without fetching
 * each one's full details. Up to `MAX_TITLE_CARDS` per request.
 */

import { TitleCardsQuerySchema, type TitleCardsResponse } from "@findr/types/tmdb";
import { factory } from "../../lib/routing/factory";
import { queryOf } from "../../lib/routing/input";
import { respond } from "../../lib/tmdb/respond";
import TMDB from "../../lib/tmdb/TMDB";

export default factory({
  GET: {
    query: TitleCardsQuerySchema,
    handler: (ctx) => {
      const { ids } = queryOf(ctx, TitleCardsQuerySchema);

      // Keys are validated as `movie:<id>` or `tv:<id>`
      const keys = ids.map((key) => {
        const [mediaType, id] = key.split(":");
        return { mediaType: mediaType === "tv" ? ("tv" as const) : ("movie" as const), id: Number(id) };
      });

      return respond(ctx, async (): Promise<TitleCardsResponse> => ({
        cards: await TMDB.getInstance().cards(keys),
      }));
    },
  },
});
