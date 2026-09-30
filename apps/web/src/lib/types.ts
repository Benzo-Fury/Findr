/**
 * View-model types for the web app.
 *
 * Everything the components touch is camelCase. Download, title and settings
 * shapes come straight from `@findr/types` — import those from there. The
 * TMDB payloads are the exception: the API passes TMDB's own snake_case field
 * names through, so the camelCase mirrors below are what `lib/api.ts` converts
 * those responses into at the fetch boundary.
 */

/* -------------------------------------------------------------------------- */
/* TMDB                                                                       */
/* -------------------------------------------------------------------------- */

/** Media kinds Findr can act on. */
export type MediaType = "movie" | "tv"

/**
 * A poster-sized summary of a title — what the grids, rows, and search results
 * render. `posterPath` is the bare TMDB path; the components add their own
 * image size prefix.
 */
export interface PosterItem {
  id: number
  mediaType: MediaType
  title: string
  posterPath: string | null
  voteAverage: number
  year?: string
}

/** One page of poster items, mirroring TMDB's pagination envelope. */
export interface PosterPage {
  page: number
  totalPages: number
  totalResults: number
  results: PosterItem[]
}

/** One horizontally-scrolling row on the discover page. */
export interface DiscoverRow {
  id: string
  title: string
  items: PosterItem[]
}

/** The discover page payload — a collection of pre-built rows. */
export interface DiscoverFeed {
  rows: DiscoverRow[]
}

/** What a download or library entry needs from TMDB to be recognisable. */
export interface TMDBMeta {
  title: string
  year: string
  posterPath: string | null
}
