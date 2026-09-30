/**
 * View-model types for the web app.
 *
 * Everything the components touch is camelCase. Shapes the API already serves
 * in camelCase — indexes and torrents — are imported straight from
 * `@findr/types` rather than restated here. The TMDB payloads are the
 * exception: the API passes TMDB's own snake_case field names through, so the
 * camelCase mirrors below are what `lib/api.ts` converts those responses into
 * at the fetch boundary. Moving the conversion into `@findr/types` would let
 * these disappear.
 */

import type { IndexWithTorrents, Torrent } from "@findr/types"

export type { IndexWithTorrents, Torrent }

/* -------------------------------------------------------------------------- */
/* Jobs                                                                       */
/* -------------------------------------------------------------------------- */

/** Where a job currently sits in the pipeline, mirroring the API's `JobStatus`. */
export type JobStage =
  | "pending"
  | "querying"
  | "deciding"
  | "sterilizing"
  | "saving"
  | "completed"
  | "failed"
  | "cancelled"

/** A job's stage plus the human-readable note the pipeline last attached. */
export interface JobStatus {
  primary: JobStage
  message?: string
}

/** Preferences a job was queued with, when it overrode the defaults. */
export interface JobPreferences {
  resolutions?: string[]
  maxFileSizeGB?: number
  minSeeders?: number
  blacklistedReleaseTypes?: string[]
}

/**
 * A queued or in-flight search. Jobs store only what the client submitted, so
 * there is no title or artwork on the row — the UI resolves those from TMDB
 * by IMDb ID.
 *
 * Timestamps are stored as epoch milliseconds and may arrive either as numbers
 * or as ISO strings depending on how the model serialises them, so both are
 * accepted.
 */
export interface Job {
  id: string
  imdbId: string
  season: number | null
  status: JobStatus
  preferences: JobPreferences | null
  userId: string
  createdAt: string | number
  updatedAt: string | number
}

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

/** The minimum a title needs before it can be shown next to an IMDb ID. */
export interface TMDBMeta {
  tmdbId: number
  title: string
  year: string
  posterPath: string | null
  overview: string
  mediaType: MediaType
}

/** Indexes belonging to one title, grouped for the library grid. */
export interface GroupedIndex {
  imdbId: string
  indexes: IndexWithTorrents[]
  meta?: TMDBMeta
}
