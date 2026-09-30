/**
 * Catalog of the named TMDB lists Findr exposes. Every curated list — whether
 * requested directly through `/api/tmdb/list/:source` or assembled into the
 * discover feed — is described here rather than in a route file, so adding a
 * new list costs one entry instead of a new endpoint.
 *
 * TMDB's curated endpoints (`/movie/top_rated`, `/tv/popular`, and friends)
 * are documented as thin wrappers over `/discover`, so several of these
 * entries call discover directly with the filters that define the list.
 */

import type { TMDBMediaType } from "@findr/types";

/** Query parameters for a list, either fixed or computed per request. */
type SourceParams = Record<string, string> | (() => Record<string, string>);

/**
 * One named list. A source either targets a single TMDB path, or a pair of
 * paths keyed by media type — the pair is what makes a source answer to the
 * `type` query parameter and support merging movies and shows together.
 */
export interface ListSource {
  /** Heading shown when this list appears as a discover row. */
  title: string;
  path: string | Record<TMDBMediaType, string>;
  params?: SourceParams;
  /** Forced media type for endpoints that only ever return one kind. */
  mediaType?: TMDBMediaType;
}

/** Fourteen days back and today, as the `YYYY-MM-DD` strings discover expects. */
function recentWindow(): { from: string; to: string } {
  const today = new Date();
  const twoWeeksAgo = new Date(today.getTime() - 14 * 24 * 60 * 60 * 1000);
  const ymd = (date: Date) => date.toISOString().slice(0, 10);

  return { from: ymd(twoWeeksAgo), to: ymd(today) };
}

/* ------------------------------------------------------------------------ */
/* Catalog                                                                    */
/* ------------------------------------------------------------------------ */

export const LIST_SOURCES = {
  trending: {
    title: "Trending Now",
    path: "/trending/all/week",
  },
  "top-rated": {
    title: "Top Rated",
    path: { movie: "/movie/top_rated", tv: "/tv/top_rated" },
  },
  popular: {
    title: "Popular",
    path: { movie: "/movie/popular", tv: "/tv/popular" },
  },
  "trending-movies": {
    title: "Top 10 Movies This Week",
    path: "/trending/movie/week",
    mediaType: "movie",
  },
  "new-releases": {
    title: "New Releases",
    path: "/discover/movie",
    mediaType: "movie",
    params: () => {
      const { from, to } = recentWindow();
      return {
        sort_by: "popularity.desc",
        with_release_type: "4|5",
        "vote_count.gte": "10",
        "primary_release_date.gte": from,
        "primary_release_date.lte": to,
      };
    },
  },
  "now-playing": {
    title: "Now Playing in Theaters",
    path: "/movie/now_playing",
    mediaType: "movie",
  },
  acclaimed: {
    title: "Critically Acclaimed",
    path: "/discover/movie",
    mediaType: "movie",
    params: {
      sort_by: "vote_average.desc",
      "vote_count.gte": "5000",
      "vote_average.gte": "8",
    },
  },
  "airing-today": {
    title: "Airing Today",
    path: "/tv/airing_today",
    mediaType: "tv",
  },
} as const satisfies Record<string, ListSource>;

/** Keys accepted by the list endpoint and the discover feed. */
export type ListSourceKey = keyof typeof LIST_SOURCES;

/** Narrows an arbitrary string to a known source key. */
export function isListSource(value: string): value is ListSourceKey {
  return value in LIST_SOURCES;
}

/** Resolves a source's parameters, invoking it when they are computed. */
export function resolveParams(source: ListSource): Record<string, string> {
  return typeof source.params === "function" ? source.params() : source.params ?? {};
}

/* ------------------------------------------------------------------------ */
/* Discover feed composition                                                  */
/* ------------------------------------------------------------------------ */

/** A row on the discover page: a source, optionally narrowed and trimmed. */
export interface FeedRow {
  source: ListSourceKey;
  /** Overrides the source's own title when the row needs different wording. */
  title?: string;
  mediaType?: TMDBMediaType;
  limit?: number;
}

/** The discover page, in display order. */
export const FEED_ROWS: FeedRow[] = [
  { source: "trending" },
  { source: "new-releases" },
  { source: "trending-movies", limit: 10 },
  { source: "popular", title: "Popular TV Shows", mediaType: "tv" },
  { source: "now-playing" },
  { source: "acclaimed" },
  { source: "top-rated", title: "Top Rated TV", mediaType: "tv" },
  { source: "airing-today" },
];
