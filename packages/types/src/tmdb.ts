/** Media kinds TMDB exposes that Findr can act on. */
export type TMDBMediaType = "movie" | "tv";

/**
 * A poster-sized summary of a title, trimmed down to what the UI grids and
 * rows actually render. `poster_path` is the bare TMDB path — clients pick
 * their own image size prefix.
 *
 * List endpoints drop entries with no artwork, so `poster_path` is only ever
 * null on search results, where a match is worth showing regardless.
 */
export interface PosterItem {
  id: number;
  media_type: TMDBMediaType;
  title: string;
  poster_path: string | null;
  vote_average: number;
  year?: string;
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
