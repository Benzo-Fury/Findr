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
  /** Wide artwork, when the list included it. */
  backdropPath?: string | null
  /** TMDB genre ids, when the list included them. */
  genreIds?: number[]
  overview?: string
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

/**
 * A library title's TMDB facts in a form small enough to hold for the whole
 * library at once: enough to render it, search it, and filter it by genre.
 */
export interface TitleCard {
  id: number
  mediaType: MediaType
  title: string
  /** Empty when TMDB has no date. */
  year: string
  posterPath: string | null
  backdropPath: string | null
  genres: string[]
  voteAverage: number
  /** Shows only; null for movies. */
  seasons: number | null
}

/** One genre, with its separate movie and TV ids where TMDB has them. */
export interface Genre {
  name: string
  movie: number | null
  tv: number | null
}

/** Orderings a genre browse can use. */
export type BrowseSort = "popular" | "rated" | "recent"
