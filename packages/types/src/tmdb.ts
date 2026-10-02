import { z } from "zod";

/** Media kinds TMDB exposes that Findr can act on. */
export type TMDBMediaType = "movie" | "tv";

/**
 * A poster-sized summary of a title, trimmed down to what the UI grids and
 * rows actually render. `poster_path` is the bare TMDB path — clients pick
 * their own image size prefix.
 *
 * List endpoints drop entries with no artwork, so `poster_path` is only ever
 * null on search results, where a match is worth showing regardless. The
 * backdrop, genre ids and overview ride along when TMDB includes them, so a
 * list can be shown in a wide layout or narrowed by genre without a lookup.
 */
export interface PosterItem {
  id: number;
  media_type: TMDBMediaType;
  title: string;
  poster_path: string | null;
  vote_average: number;
  year?: string;
  backdrop_path?: string | null;
  genre_ids?: number[];
  overview?: string;
}

/** A single page of poster items, mirroring TMDB's pagination envelope. */
export interface PosterPage {
  page: number;
  total_pages: number;
  total_results: number;
  results: PosterItem[];
}

/** One horizontally-scrolling row on the discover page. */
export interface DiscoverRow {
  id: string;
  title: string;
  items: PosterItem[];
}

/** The full discover page payload — a collection of pre-built rows. */
export interface DiscoverFeed {
  rows: DiscoverRow[];
}

// ---------- Title cards ---------- //

/**
 * What a library listing needs to show and search a title it only knows by
 * TMDB identity: names, artwork and the facets it is filtered by. Much smaller
 * than the full details payload, so a whole library can be resolved at once.
 */
export interface TitleCard {
  id: number;
  media_type: TMDBMediaType;
  title: string;
  /** Empty when TMDB has no release or first-air date. */
  year: string;
  poster_path: string | null;
  backdrop_path: string | null;
  genres: string[];
  vote_average: number;
  /** Shows only; null for movies. */
  number_of_seasons: number | null;
}

/** Most title cards one request may ask for. */
export const MAX_TITLE_CARDS = 50;

/** A TMDB identity written as `movie:603` or `tv:1399`. */
const TitleKeySchema = z.string().regex(/^(movie|tv):\d+$/, "Expected movie:<id> or tv:<id>");

/** Query for `GET /api/tmdb/cards`: a comma-separated list of title keys. */
export const TitleCardsQuerySchema = z.object({
  ids: z
    .string()
    .transform((value) => [...new Set(value.split(",").map((key) => key.trim()).filter(Boolean))])
    .pipe(z.array(TitleKeySchema).min(1).max(MAX_TITLE_CARDS)),
});
export type TitleCardsQuery = z.infer<typeof TitleCardsQuerySchema>;

/** What `GET /api/tmdb/cards` returns. Titles TMDB could not resolve are left out. */
export interface TitleCardsResponse {
  cards: TitleCard[];
}

// ---------- Genres and browsing ---------- //

/**
 * One genre across both media kinds. TMDB numbers movie and TV genres
 * separately and names some only on one side, so each id may be missing.
 */
export interface GenreEntry {
  name: string;
  movie: number | null;
  tv: number | null;
}

/** What `GET /api/tmdb/genres` returns, in alphabetical order. */
export interface GenresResponse {
  genres: GenreEntry[];
}

/** Orderings a genre browse can use. */
export const BrowseSortSchema = z.enum(["popular", "rated", "recent"]);
export type BrowseSort = z.infer<typeof BrowseSortSchema>;

/**
 * Query for `GET /api/tmdb/browse`: one page of titles in a genre. Movie and
 * TV genre ids are given separately because TMDB numbers them separately;
 * with `type=all`, a side with no id is skipped.
 */
export const BrowseQuerySchema = z.object({
  type: z.enum(["movie", "tv", "all"]).default("all"),
  movieGenre: z.coerce.number().int().positive().optional(),
  tvGenre: z.coerce.number().int().positive().optional(),
  sort: BrowseSortSchema.default("popular"),
  page: z.coerce.number().int().min(1).max(500).default(1),
});
export type BrowseQuery = z.infer<typeof BrowseQuerySchema>;
