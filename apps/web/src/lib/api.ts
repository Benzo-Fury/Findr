/**
 * The single boundary between the web app and the API.
 *
 * Two things happen here and nowhere else. Every URL the app calls is written
 * down once, so a route rename touches one file. And TMDB's snake_case field
 * names are converted into the camelCase view models the components use — the
 * API forwards TMDB's own naming, so this is where it stops.
 */

import type {
  DiscoverFeed,
  DiscoverRow,
  IndexWithTorrents,
  Job,
  MediaType,
  PosterItem,
  PosterPage,
} from "./types"

/* -------------------------------------------------------------------------- */
/* Transport                                                                  */
/* -------------------------------------------------------------------------- */

/** Error codes the API returns, in the words a user should see instead. */
const ERROR_MESSAGES: Record<string, string> = {
  already_indexed: "This title has already been indexed.",
  tmdb_unavailable: "TMDB is unreachable right now. Try again shortly.",
  unknown_source: "That list does not exist.",
  not_found: "That item no longer exists.",
  torrent_not_found: "That torrent is no longer available.",
  unauthorized: "Your session expired. Sign in again.",
}

/** Raised for any non-2xx response, carrying the API's error code when present. */
export class ApiError extends Error {
  constructor(
    message: string,
    public readonly code: string | null,
    public readonly status: number,
  ) {
    super(message)
  }
}

/** Turns a failed response into an ApiError with the friendliest message available. */
async function toError(res: Response): Promise<ApiError> {
  const body = await res.json().catch(() => ({}) as Record<string, unknown>)
  const code = typeof body.error === "string" ? body.error : null

  // Too many requests has no error body — the job creation route rate limits.
  if (res.status === 429) {
    return new ApiError("You're creating jobs too quickly. Wait a moment.", code, 429)
  }

  const message =
    (code && ERROR_MESSAGES[code]) ?? code ?? `Request failed: ${res.status}`

  return new ApiError(message, code, res.status)
}

/** Performs a request and decodes the JSON body, throwing ApiError on failure. */
async function request<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, init)
  if (!res.ok) throw await toError(res)
  return res.json() as Promise<T>
}

/** Performs a request that answers with no body, such as a delete. */
async function send(url: string, init: RequestInit): Promise<void> {
  const res = await fetch(url, init)
  if (!res.ok && res.status !== 204) throw await toError(res)
}

/** Serialises a JSON body with the header the validation middleware expects. */
function json(body: unknown): RequestInit {
  return {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  }
}

/* -------------------------------------------------------------------------- */
/* TMDB conversion                                                            */
/* -------------------------------------------------------------------------- */

/** A poster item exactly as the API sends it, in TMDB's naming. */
interface RawPosterItem {
  id: number
  media_type: MediaType
  title: string
  poster_path: string | null
  vote_average: number
  year?: string
}

interface RawPosterPage {
  page: number
  total_pages: number
  total_results: number
  results: RawPosterItem[]
}

/** Converts one API poster item into the camelCase shape components render. */
function toPosterItem(raw: RawPosterItem): PosterItem {
  return {
    id: raw.id,
    mediaType: raw.media_type,
    title: raw.title,
    posterPath: raw.poster_path,
    voteAverage: raw.vote_average,
    year: raw.year,
  }
}

/** Converts a paginated poster response, page envelope included. */
function toPosterPage(raw: RawPosterPage): PosterPage {
  return {
    page: raw.page,
    totalPages: raw.total_pages,
    totalResults: raw.total_results,
    results: raw.results.map(toPosterItem),
  }
}

/* -------------------------------------------------------------------------- */
/* Indexes                                                                    */
/* -------------------------------------------------------------------------- */

/** Every index belonging to the signed-in user, each with its scored torrents. */
export function fetchIndexes(): Promise<IndexWithTorrents[]> {
  return request<IndexWithTorrents[]>("/api/indexes")
}

/**
 * The indexes recorded for one title.
 *
 * The API has no per-title lookup, so this filters the user's full index list.
 * A dedicated endpoint would make this a single cheap request.
 */
export async function lookupIndexes(
  imdbId: string,
  init?: RequestInit,
): Promise<IndexWithTorrents[]> {
  const all = await request<IndexWithTorrents[]>("/api/indexes", init)
  return all.filter((index) => index.imdbId === imdbId)
}

/** Removes an index and every torrent stored beneath it. */
export function deleteIndex(id: string): Promise<void> {
  return send(`/api/indexes/${id}/delete`, { method: "DELETE" })
}

/** Drops an index and queues a fresh job for the same title in one call. */
export function reindex(id: string): Promise<Job> {
  return request<Job>(`/api/indexes/${id}/reindex`, { method: "POST" })
}

/** Repoints an index at a different torrent and queues the download again. */
export function redownload(id: string, torrentId: string): Promise<Job> {
  return request<Job>(`/api/indexes/${id}/redownload`, json({ torrentId }))
}

/* -------------------------------------------------------------------------- */
/* Jobs                                                                       */
/* -------------------------------------------------------------------------- */

/** The signed-in user's most recent jobs, newest first. */
export function fetchJobs(): Promise<Job[]> {
  return request<Job[]>("/api/jobs")
}

/**
 * Queues a search for a title. Season is only meaningful for shows.
 *
 * The API answers with the existing job when one is already running for this
 * title, and rejects with `already_indexed` when it has been indexed before.
 */
export function createJob(imdbId: string, season?: number): Promise<Job> {
  return request<Job>("/api/jobs/create", json({ imdbId, season }))
}

/** Removes a finished or failed job from the list. */
export function deleteJob(id: string): Promise<void> {
  return send(`/api/jobs/${id}/delete`, { method: "DELETE" })
}

/* -------------------------------------------------------------------------- */
/* TMDB                                                                       */
/* -------------------------------------------------------------------------- */

/** Named lists the API's source catalog serves. */
export type ListSource =
  | "trending"
  | "top-rated"
  | "popular"
  | "trending-movies"
  | "new-releases"
  | "now-playing"
  | "acclaimed"
  | "airing-today"

/**
 * One page of a named list. Sources defined over both movies and shows honour
 * the media type; the rest ignore it.
 */
export function fetchList(
  source: ListSource,
  page = 1,
  mediaType?: string,
): Promise<PosterPage> {
  const params = new URLSearchParams({ page: String(page) })
  if (mediaType && mediaType !== "all") params.set("type", mediaType)

  return request<RawPosterPage>(`/api/tmdb/list/${source}?${params}`).then(toPosterPage)
}

/** The pre-built discover rows. */
export async function fetchDiscoverFeed(): Promise<DiscoverFeed> {
  const raw = await request<{ rows: { id: string; title: string; items: RawPosterItem[] }[] }>(
    "/api/tmdb/discover-feed",
  )

  const rows: DiscoverRow[] = raw.rows.map((row) => ({
    id: row.id,
    title: row.title,
    items: row.items.map(toPosterItem),
  }))

  return { rows }
}

/** Multi-search across movies and shows. */
export function searchTMDB(query: string): Promise<PosterPage> {
  return request<RawPosterPage>(
    `/api/tmdb/search?q=${encodeURIComponent(query)}`,
  ).then(toPosterPage)
}

/**
 * Full details for a title. Left as raw TMDB JSON — the detail dialog reads a
 * long tail of fields that only it cares about.
 */
export function fetchTMDBDetails(
  mediaType: MediaType,
  id: number,
  init?: RequestInit,
): Promise<Record<string, unknown>> {
  return request<Record<string, unknown>>(`/api/tmdb/details/${mediaType}/${id}`, init)
}

/** Resolves an IMDb ID to its TMDB records. */
export function findByImdbId(
  imdbId: string,
  init?: RequestInit,
): Promise<Record<string, unknown>> {
  return request<Record<string, unknown>>(`/api/tmdb/find/${imdbId}`, init)
}

/** Trending posters for the login backdrop. The one endpoint open to guests. */
export function fetchFeatured(): Promise<PosterItem[]> {
  return request<RawPosterItem[]>("/api/tmdb/featured").then((items) =>
    items.map(toPosterItem),
  )
}
