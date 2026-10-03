/**
 * The title sheet's reading of TMDB's detail payload. The API forwards TMDB's
 * raw JSON with videos, credits, recommendations and release dates appended;
 * this turns the long tail of fields the sheet uses into one typed object.
 */

import type { MediaType, PosterItem } from "@/lib/types"

/** One season as the season picker shows it. */
export interface SeasonInfo {
  number: number
  name: string
  episodes: number
  airDate: string | null
}

export interface CastMember {
  name: string
  character: string
  profilePath: string | null
}

/** Everything the title sheet renders about a title. */
export interface TitleDetails {
  title: string
  tagline: string
  overview: string
  date: string
  year: string
  runtime: number | null
  rating: number
  genres: string[]
  posterPath: string | null
  backdropPath: string | null
  seasons: SeasonInfo[]
  trailerKey: string | null
  cast: CastMember[]
  recommendations: PosterItem[]
  /** Why downloads may disappoint right now, or null when there is no reason to think so. */
  availabilityWarning: string | null
}

/** A title released within this window may not have good releases yet. */
const RECENT_RELEASE_MS = 30 * 24 * 60 * 60 * 1000

/**
 * A movie whose cinema release is older than this is assumed to be out on
 * digital, since TMDB often lists no digital or physical date at all.
 */
const THEATRICAL_WINDOW_MS = 120 * 24 * 60 * 60 * 1000

type Raw = Record<string, unknown>

const text = (value: unknown): string => (typeof value === "string" ? value : "")
const list = <T>(value: unknown): T[] => (Array.isArray(value) ? (value as T[]) : [])
const nested = (value: unknown, key: string): unknown => (value && typeof value === "object" ? (value as Raw)[key] : undefined)

/** Reads TMDB's detail payload for a movie or show. */
export function readDetails(raw: Raw, mediaType: MediaType): TitleDetails {
  const date = text(raw.release_date) || text(raw.first_air_date)
  const runtime = typeof raw.runtime === "number" && raw.runtime > 0 ? raw.runtime : list<number>(raw.episode_run_time)[0] ?? null

  // Prefer an official YouTube trailer, then any trailer, then any video
  const videos = list<{ key: string; site: string; type: string; official: boolean }>(nested(raw.videos, "results"))
  const youtube = videos.filter((video) => video.site === "YouTube")
  const trailer =
    youtube.find((video) => video.type === "Trailer" && video.official) ?? youtube.find((video) => video.type === "Trailer") ?? youtube[0]

  return {
    title: text(raw.title) || text(raw.name),
    tagline: text(raw.tagline),
    overview: text(raw.overview),
    date,
    year: date.slice(0, 4),
    runtime,
    rating: typeof raw.vote_average === "number" ? raw.vote_average : 0,
    genres: list<{ name: string }>(raw.genres).map((genre) => genre.name),
    posterPath: text(raw.poster_path) || null,
    backdropPath: text(raw.backdrop_path) || null,
    seasons: readSeasons(raw),
    trailerKey: trailer?.key ?? null,
    cast: list<{ name: string; character: string; profile_path: string | null }>(nested(raw.credits, "cast"))
      .slice(0, 14)
      .map((member) => ({ name: member.name, character: member.character, profilePath: member.profile_path })),
    recommendations: readRecommendations(raw),
    availabilityWarning: readAvailability(raw, mediaType, date),
  }
}

/** Numbered seasons in order; specials (season 0) go last when present. */
function readSeasons(raw: Raw): SeasonInfo[] {
  const seasons = list<{ season_number: number; name: string; episode_count: number; air_date: string | null }>(raw.seasons).map((season) => ({
    number: season.season_number,
    name: season.name,
    episodes: season.episode_count,
    airDate: season.air_date,
  }))

  if (seasons.length === 0 && typeof raw.number_of_seasons === "number") {
    return Array.from({ length: raw.number_of_seasons }, (_, index) => ({ number: index + 1, name: `Season ${index + 1}`, episodes: 0, airDate: null }))
  }
  return [...seasons.filter((season) => season.number > 0), ...seasons.filter((season) => season.number === 0)]
}

/** TMDB's recommendations as poster items, artwork only. */
function readRecommendations(raw: Raw): PosterItem[] {
  return list<{ id: number; title?: string; name?: string; media_type: string; poster_path: string | null; vote_average: number; release_date?: string; first_air_date?: string }>(
    nested(raw.recommendations, "results"),
  )
    .filter((item) => item.poster_path)
    .slice(0, 18)
    .map((item) => ({
      id: item.id,
      mediaType: item.media_type === "tv" ? "tv" : "movie",
      title: item.title || item.name || "",
      posterPath: item.poster_path,
      voteAverage: item.vote_average,
      year: (item.release_date || item.first_air_date || "").slice(0, 4) || undefined,
    }))
}

/**
 * Warns when a movie is still only in cinemas, or when anything came out in
 * the last month, since good releases may not exist yet.
 */
function readAvailability(raw: Raw, mediaType: MediaType, date: string): string | null {
  const now = Date.now()

  if (mediaType === "movie") {
    const countries = list<{ iso_3166_1: string; release_dates: { type: number; release_date: string }[] }>(nested(raw.release_dates, "results"))
    if (countries.length > 0) {
      const releases = countries.find((country) => country.iso_3166_1 === "US")?.release_dates ?? countries.flatMap((country) => country.release_dates)
      const released = (types: number[]) =>
        releases.filter((release) => types.includes(release.type)).map((release) => new Date(release.release_date).getTime()).filter((time) => time <= now)

      // Theatrical is type 2 or 3; digital and physical are 4 and 5. Only a first cinema release inside the window counts
      const theatrical = released([2, 3])
      const inCinemas = theatrical.length > 0 && now - Math.min(...theatrical) < THEATRICAL_WINDOW_MS
      if (inCinemas && released([4, 5]).length === 0) return "Only in cinemas so far. Releases may be missing or poor quality."
    }
  }

  if (date) {
    const released = new Date(date).getTime()
    if (now >= released && now - released < RECENT_RELEASE_MS) return "Released in the last month. Releases may be missing or poor quality."
  }
  return null
}
