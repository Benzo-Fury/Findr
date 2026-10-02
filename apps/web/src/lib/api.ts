/**
 * The single boundary between the web app and the API.
 *
 * Two things happen here and nowhere else. Every URL the app calls is written
 * down once, so a route rename touches one file. And TMDB's snake_case field
 * names are converted into the camelCase view models the components use — the
 * API forwards TMDB's own naming, so this is where it stops.
 */

import type {
  CreateDownloadRequest,
  DownloadDetail,
  DownloadSummary,
  ListDownloadsQuery,
  Paginated,
  TitleSummary,
} from "@findr/types/downloads"
import type { CredentialsReset } from "@findr/types/account"
import type { SettingsPatch, SettingsResponse } from "@findr/types/settings"
import type {
  DiscoverFeed,
  DiscoverRow,
  MediaType,
  PosterItem,
  PosterPage,
} from "./types"

/* -------------------------------------------------------------------------- */
/* Transport                                                                  */
/* -------------------------------------------------------------------------- */

/** Error codes the API returns, in the words a user should see instead. */
const ERROR_MESSAGES: Record<string, string> = {
  already_downloading: "This is already downloading.",
  not_finished: "Wait for the download to finish first.",
  candidate_not_found: "That release is no longer available.",
  tmdb_unavailable: "TMDB is unreachable right now. Try again shortly.",
  unknown_source: "That list does not exist.",
  not_found: "That item no longer exists.",
  unauthorized: "Your session expired. Sign in again.",
  forbidden: "Only admins can do that.",
  rate_limited: "Too many requests. Wait a moment and try again.",
  validation_failed: "Some of those values are not valid.",
  reset_required: "Set your own email and password first.",
  remote_access_disabled: "Remote access is disabled. Enable it on the Settings page from the server itself.",
  email_unchanged: "Choose your own email address.",
  email_taken: "Another account already uses that email.",
  reset_not_required: "This account already has its own credentials.",
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
function json(body: unknown, method: "POST" | "PATCH" = "POST"): RequestInit {
  return {
    method,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  }
}

/** Builds a query string from defined values only. */
function query(params: Record<string, string | number | undefined>): string {
  const search = new URLSearchParams()
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined) search.set(key, String(value))
  }
  return search.toString()
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
/* Titles                                                                     */
/* -------------------------------------------------------------------------- */

/** A page of requested titles, most recently active first, each with its downloads. */
export function fetchTitles(page = 1, pageSize = 100): Promise<Paginated<TitleSummary>> {
  return request(`/api/titles?${query({ page, pageSize })}`)
}

/** The requested title for a TMDB identity, or null when it has never been requested. */
export async function lookupTitle(
  tmdbId: number,
  mediaType: MediaType,
  init?: RequestInit,
): Promise<TitleSummary | null> {
  const page = await request<Paginated<TitleSummary>>(`/api/titles?${query({ tmdbId, mediaType })}`, init)
  return page.items[0] ?? null
}

/** Forgets a title and its download history. Library files are kept. */
export function deleteTitle(id: string): Promise<void> {
  return send(`/api/titles/${id}`, { method: "DELETE" })
}

/* -------------------------------------------------------------------------- */
/* Downloads                                                                  */
/* -------------------------------------------------------------------------- */

/** A page of downloads, newest activity first. */
export function fetchDownloads(
  options: Partial<Pick<ListDownloadsQuery, "page" | "pageSize" | "state">> = {},
): Promise<Paginated<DownloadSummary>> {
  return request(`/api/downloads?${query(options)}`)
}

/** Everything about one download: episodes, candidates and attempts. */
export function fetchDownload(id: string, init?: RequestInit): Promise<DownloadDetail> {
  return request(`/api/downloads/${id}`, init)
}

/** Queues a movie, or one season of a show. */
export function createDownload(body: CreateDownloadRequest): Promise<DownloadSummary> {
  return request("/api/downloads", json(body))
}

/** Stops a download; resolves once it has cleaned up. */
export function cancelDownload(id: string): Promise<DownloadSummary> {
  return request(`/api/downloads/${id}/cancel`, { method: "POST" })
}

/** Runs a finished download again, optionally trying a specific release first. */
export function retryDownload(id: string, candidateId?: string): Promise<DownloadSummary> {
  return request(`/api/downloads/${id}/retry`, json(candidateId ? { candidateId } : {}))
}

/** Removes a download and its history. Library files are kept. */
export function deleteDownload(id: string): Promise<void> {
  return send(`/api/downloads/${id}`, { method: "DELETE" })
}

/* -------------------------------------------------------------------------- */
/* Settings                                                                   */
/* -------------------------------------------------------------------------- */

/** The server's settings. Admins only. */
export function fetchSettings(): Promise<SettingsResponse> {
  return request("/api/settings")
}

/** Changes any subset of settings and returns the result. Admins only. */
export function updateSettings(patch: SettingsPatch): Promise<SettingsResponse> {
  return request("/api/settings", json(patch, "PATCH"))
}

/* -------------------------------------------------------------------------- */
/* Account                                                                    */
/* -------------------------------------------------------------------------- */

/** Replaces the initial `admin` / `admin` credentials. The session stays signed in. */
export function resetCredentials(body: CredentialsReset): Promise<void> {
  return send("/api/account/credentials", json(body))
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

/** Trending posters for the login backdrop. The one endpoint open to guests. */
export function fetchFeatured(): Promise<PosterItem[]> {
  return request<RawPosterItem[]>("/api/tmdb/featured").then((items) =>
    items.map(toPosterItem),
  )
}
