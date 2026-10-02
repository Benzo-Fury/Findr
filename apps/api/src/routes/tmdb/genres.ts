/**
 * Every TMDB genre, merged by name across movies and shows, for the discover
 * page's genre categories.
 */

import type { GenresResponse } from "@findr/types/tmdb";
import { factory } from "../../lib/routing/factory";
import { respond } from "../../lib/tmdb/respond";
import TMDB from "../../lib/tmdb/TMDB";

export default factory({
  GET: (ctx) =>
    respond(ctx, async (): Promise<GenresResponse> => ({ genres: await TMDB.getInstance().genres() })),
});
