import { useState, useEffect } from "react"
import { Film, Tv, Star, X, Calendar, Clock, Loader2, Download, CheckCircle2, AlertTriangle } from "lucide-react"
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { TMDB_API_KEY, TMDB_BASE, type TMDBDiscoverItem } from "@/hooks/use-tmdb-trending"
import { fetchIMDbId } from "@/hooks/use-tmdb-search"

const TMDB_IMAGE = "https://image.tmdb.org/t/p/w500"

interface MediaDetailDialogProps {
  item: TMDBDiscoverItem | null
  open: boolean
  onOpenChange: (open: boolean) => void
  onIndexed?: () => void
}

interface TMDBDetail {
  runtime: number | null
  genres: string[]
  trailerKey: string | null
  numberOfSeasons: number | null
  contentRating: string | null
}

const RATING_COLORS: Record<string, { bg: string; text: string; border: string }> = {
  "G":      { bg: "bg-green-100", text: "text-green-800", border: "border-green-300" },
  "TV-G":   { bg: "bg-green-100", text: "text-green-800", border: "border-green-300" },
  "TV-Y":   { bg: "bg-green-100", text: "text-green-800", border: "border-green-300" },
  "TV-Y7":  { bg: "bg-green-100", text: "text-green-800", border: "border-green-300" },
  "PG":     { bg: "bg-yellow-100", text: "text-yellow-800", border: "border-yellow-300" },
  "TV-PG":  { bg: "bg-yellow-100", text: "text-yellow-800", border: "border-yellow-300" },
  "PG-13":  { bg: "bg-orange-100", text: "text-orange-800", border: "border-orange-300" },
  "TV-14":  { bg: "bg-orange-100", text: "text-orange-800", border: "border-orange-300" },
  "R":      { bg: "bg-red-100", text: "text-red-800", border: "border-red-300" },
  "TV-MA":  { bg: "bg-red-100", text: "text-red-800", border: "border-red-300" },
  "NC-17":  { bg: "bg-red-200", text: "text-red-900", border: "border-red-400" },
}

const DEFAULT_RATING_COLORS = { bg: "bg-gray-100", text: "text-gray-700", border: "border-gray-300" }

async function fetchContentRating(id: number, mediaType: "movie" | "tv"): Promise<string | null> {
  try {
    if (mediaType === "movie") {
      const res = await fetch(`${TMDB_BASE}/movie/${id}/release_dates?api_key=${TMDB_API_KEY}`)
      const data = await res.json()
      const us = (data.results ?? []).find((r: any) => r.iso_3166_1 === "US")
      return us?.release_dates?.find((rd: any) => rd.certification)?.certification ?? null
    } else {
      const res = await fetch(`${TMDB_BASE}/tv/${id}/content_ratings?api_key=${TMDB_API_KEY}`)
      const data = await res.json()
      return (data.results ?? []).find((r: any) => r.iso_3166_1 === "US")?.rating ?? null
    }
  } catch {
    return null
  }
}

async function fetchDetail(
  id: number,
  mediaType: "movie" | "tv"
): Promise<TMDBDetail> {
  const [detailRes, videosRes, contentRating] = await Promise.all([
    fetch(`${TMDB_BASE}/${mediaType}/${id}?api_key=${TMDB_API_KEY}`),
    fetch(`${TMDB_BASE}/${mediaType}/${id}/videos?api_key=${TMDB_API_KEY}`),
    fetchContentRating(id, mediaType),
  ])
  const [detail, videos] = await Promise.all([
    detailRes.json(),
    videosRes.json(),
  ])

  const trailer = (videos.results ?? []).find(
    (v: any) =>
      v.site === "YouTube" &&
      v.type === "Trailer" &&
      v.official !== false
  ) ?? (videos.results ?? []).find(
    (v: any) => v.site === "YouTube" && v.type === "Trailer"
  ) ?? (videos.results ?? []).find(
    (v: any) => v.site === "YouTube"
  )

  const runtime =
    mediaType === "movie"
      ? detail.runtime ?? null
      : detail.episode_run_time?.[0] ?? null

  const genres = (detail.genres ?? []).map((g: any) => g.name)
  const numberOfSeasons = mediaType === "tv" ? (detail.number_of_seasons ?? null) : null

  return {
    runtime,
    genres,
    trailerKey: trailer?.key ?? null,
    numberOfSeasons,
    contentRating,
  }
}

function formatRuntime(minutes: number): string {
  const h = Math.floor(minutes / 60)
  const m = minutes % 60
  if (h === 0) return `${m}m`
  return `${h}h ${m}m`
}

function getRecencyWarning(releaseDate: string): string | null {
  if (!releaseDate) return null
  const released = new Date(releaseDate)
  if (Number.isNaN(released.getTime())) return null
  const diffMs = Date.now() - released.getTime()
  if (diffMs < 0) {
    return "This title hasn't been released yet. Torrents will almost certainly be unavailable."
  }
  const diffDays = Math.floor(diffMs / (1000 * 60 * 60 * 24))
  if (diffDays > 30) return null
  const ago = diffDays === 0 ? "today" : diffDays === 1 ? "yesterday" : `${diffDays} days ago`
  return `Released ${ago}. This content is still very new. Available downloads may be scarce, low quality, or entirely unavailable. Torrents become more reliable over time.`
}

export function MediaDetailDialog({
  item,
  open,
  onOpenChange,
  onIndexed,
}: MediaDetailDialogProps) {
  const [detail, setDetail] = useState<TMDBDetail | null>(null)
  const [loading, setLoading] = useState(false)
  const [selectedSeason, setSelectedSeason] = useState<number | null>(null)
  const [seasonAirDate, setSeasonAirDate] = useState<string | null>(null)
  const [indexing, setIndexing] = useState(false)
  const [indexResult, setIndexResult] = useState<"success" | "error" | null>(null)
  const [indexError, setIndexError] = useState("")

  useEffect(() => {
    if (!item || !open) {
      setDetail(null)
      return
    }

    let cancelled = false
    setLoading(true)

    fetchDetail(item.id, item.mediaType)
      .then((d) => {
        if (!cancelled) setDetail(d)
      })
      .catch(() => {
        if (!cancelled) setDetail(null)
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })

    return () => {
      cancelled = true
    }
  }, [item?.id, item?.mediaType, open])

  useEffect(() => {
    if (!item || item.mediaType !== "tv" || selectedSeason == null) {
      setSeasonAirDate(null)
      return
    }
    let cancelled = false
    fetch(`${TMDB_BASE}/tv/${item.id}/season/${selectedSeason}?api_key=${TMDB_API_KEY}`)
      .then((res) => res.json())
      .then((data) => {
        if (!cancelled) setSeasonAirDate(data.air_date ?? null)
      })
      .catch(() => {
        if (!cancelled) setSeasonAirDate(null)
      })
    return () => { cancelled = true }
  }, [item?.id, item?.mediaType, selectedSeason])

  function handleOpenChange(v: boolean) {
    onOpenChange(v)
    if (!v) {
      setSelectedSeason(null)
      setSeasonAirDate(null)
      setIndexing(false)
      setIndexResult(null)
      setIndexError("")
    }
  }

  async function handleIndex() {
    if (!item || indexing) return
    setIndexing(true)
    setIndexResult(null)
    setIndexError("")

    try {
      const imdbId = await fetchIMDbId(item.id, item.mediaType)
      if (!imdbId) {
        setIndexError("Could not find IMDb ID for this title")
        setIndexing(false)
        return
      }

      const res = await fetch("/api/jobs/create", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({
          imdbId,
          ...(item.mediaType === "tv" ? { season: selectedSeason } : {}),
        }),
      })

      if (!res.ok) {
        const data = await res.json().catch(() => null)
        throw new Error(data?.message ?? `Request failed (${res.status})`)
      }

      setIndexResult("success")
      onIndexed?.()
    } catch (err) {
      setIndexResult("error")
      setIndexError(err instanceof Error ? err.message : "Failed to create job")
    } finally {
      setIndexing(false)
    }
  }

  if (!item) return null

  const isMovie = item.mediaType === "movie"
  const TypeIcon = isMovie ? Film : Tv

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent
        showCloseButton={false}
        className="max-w-6xl max-h-[90vh] p-0 overflow-hidden flex flex-col rounded-2xl gap-0"
      >
        {/* Title Bar */}
        <div className="flex items-center justify-end px-5 pt-3 pb-2 bg-white z-10 shrink-0">
          <DialogHeader>
            <DialogTitle className="sr-only">{item.title}</DialogTitle>
          </DialogHeader>
          <button
            onClick={() => handleOpenChange(false)}
            className="w-10 h-10 flex items-center justify-center rounded-full hover:bg-findr-hover text-findr-secondary hover:text-findr-text transition-colors bg-white border border-transparent hover:border-findr-border shrink-0"
          >
            <X className="size-5" />
          </button>
        </div>

        {/* Scrollable content */}
        <div className="flex flex-col flex-1 overflow-y-auto bg-findr-bg">
          {/* Top: Poster & Metadata */}
          <div className="w-full p-4 sm:p-6 border-b border-findr-border bg-white flex flex-col md:flex-row gap-6 shrink-0">
            {/* Poster */}
            <div className="w-[60%] sm:w-1/2 md:w-[260px] lg:w-[300px] mx-auto md:mx-0 aspect-[2/3] rounded-xl overflow-hidden shadow-md border border-findr-border shrink-0">
              {item.posterPath ? (
                <img
                  src={`${TMDB_IMAGE}${new URL(item.posterPath).pathname}`}
                  alt={item.title}
                  className="w-full h-full object-cover"
                />
              ) : (
                <div className="w-full h-full flex items-center justify-center bg-findr-hover">
                  <TypeIcon className="size-12 text-findr-tertiary" />
                </div>
              )}
            </div>

            {/* Info */}
            <div className="flex-1 flex flex-col gap-5">
              {/* Type badge */}
              <div className="flex items-center gap-3">
                <div
                  className={`${
                    isMovie
                      ? "bg-[rgba(34,197,94,0.15)] text-findr-success border-[rgba(34,197,94,0.2)]"
                      : "bg-[rgba(245,168,38,0.15)] text-findr-amber border-[rgba(245,168,38,0.2)]"
                  } px-3 py-1 rounded-full flex items-center gap-1.5 border`}
                >
                  <TypeIcon className="size-3.5" />
                  <span className="text-xs font-bold uppercase tracking-widest">
                    {isMovie ? "Movie" : "Series"}
                  </span>
                </div>
              </div>

              {/* Title */}
              <h2 className="text-2xl md:text-3xl font-extrabold text-findr-text leading-tight">
                {item.title}{" "}
                <span className="text-findr-tertiary font-medium">
                  ({item.year})
                </span>
              </h2>

              {/* Meta row */}
              <div className="flex flex-wrap items-center gap-4 text-sm text-findr-secondary">
                {detail?.contentRating && (() => {
                  const colors = RATING_COLORS[detail.contentRating] ?? DEFAULT_RATING_COLORS
                  return (
                    <span className={`${colors.bg} ${colors.text} ${colors.border} border px-2 py-0.5 rounded text-xs font-extrabold tracking-wide`}>
                      {detail.contentRating}
                    </span>
                  )
                })()}
                <div className="flex items-center gap-1.5 text-findr-amber font-bold">
                  <Star className="size-4 fill-current" />
                  <span className="text-findr-text">{item.rating.toFixed(1)}</span>
                  <span className="text-findr-tertiary font-normal text-xs">/ 10</span>
                </div>
                {item.year && (
                  <span className="flex items-center gap-1.5">
                    <Calendar className="size-3.5 text-findr-tertiary" />
                    {item.year}
                  </span>
                )}
                {detail?.runtime && (
                  <span className="flex items-center gap-1.5">
                    <Clock className="size-3.5 text-findr-tertiary" />
                    {formatRuntime(detail.runtime)}
                  </span>
                )}
              </div>

              {/* Genres */}
              {detail?.genres && detail.genres.length > 0 && (
                <div className="flex flex-wrap gap-2">
                  {detail.genres.map((genre) => (
                    <span
                      key={genre}
                      className="px-3 py-1 rounded-full bg-findr-hover border border-findr-border text-xs font-bold text-findr-secondary"
                    >
                      {genre}
                    </span>
                  ))}
                </div>
              )}

              {/* Overview */}
              {item.overview && (
                <p className="text-sm text-findr-secondary leading-relaxed">
                  {item.overview}
                </p>
              )}

              {/* Recency Warning */}
              {(() => {
                const dateToCheck = !isMovie && seasonAirDate ? seasonAirDate : item.releaseDate
                const warning = getRecencyWarning(dateToCheck)
                if (!warning) return null
                return (
                  <div className="flex items-start gap-3 p-3 rounded-lg bg-amber-50 border border-amber-200">
                    <AlertTriangle className="size-5 text-amber-500 shrink-0 mt-0.5" />
                    <p className="text-xs text-amber-700 leading-relaxed font-medium">
                      {warning}
                    </p>
                  </div>
                )
              })()}

              {/* Season Selector (TV only) */}
              {!isMovie && detail?.numberOfSeasons && (
                <div className="flex items-center gap-3">
                  <label className="text-sm font-bold text-findr-text">Season</label>
                  <select
                    value={selectedSeason ?? ""}
                    onChange={(e) => setSelectedSeason(e.target.value ? Number(e.target.value) : null)}
                    className="h-10 px-4 bg-white border border-findr-border rounded-lg text-sm font-medium text-findr-text focus:outline-none focus:border-findr-amber cursor-pointer hover:border-findr-tertiary transition-all appearance-none pr-8 bg-no-repeat"
                    style={{
                      backgroundImage: `url('data:image/svg+xml;utf8,<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="%23666666" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m6 9 6 6 6-6"/></svg>')`,
                      backgroundPosition: "right 10px center",
                      backgroundSize: "16px",
                    }}
                  >
                    <option value="">Select season</option>
                    {Array.from({ length: detail.numberOfSeasons }, (_, i) => (
                      <option key={i + 1} value={i + 1}>
                        Season {i + 1}
                      </option>
                    ))}
                  </select>
                </div>
              )}

              {/* Index Button */}
              <div className="flex items-center gap-3 pt-1">
                <button
                  onClick={handleIndex}
                  disabled={indexing || indexResult === "success" || (!isMovie && selectedSeason === null)}
                  className="h-11 px-6 bg-findr-amber hover:bg-findr-amber-hover disabled:opacity-60 text-findr-text font-bold text-sm rounded-lg flex items-center justify-center gap-2 transition-colors shadow-lg shadow-amber-500/20"
                >
                  {indexing ? (
                    <Loader2 className="size-[18px] animate-spin" />
                  ) : indexResult === "success" ? (
                    <CheckCircle2 className="size-[18px]" />
                  ) : (
                    <Download className="size-[18px]" />
                  )}
                  {indexResult === "success" ? "Indexed" : "Index Item"}
                </button>
                {indexError && (
                  <p className="text-xs text-findr-error">{indexError}</p>
                )}
              </div>
            </div>
          </div>

          {/* Trailer Section */}
          <div className="w-full p-4 sm:p-6 bg-[#F8F9FA]">
            <h3 className="text-lg font-extrabold text-findr-text mb-4 flex items-center gap-2">
              <Film className="size-5 text-findr-amber" />
              Trailer
            </h3>

            {loading ? (
              <div className="flex items-center justify-center py-16">
                <Loader2 className="size-6 animate-spin text-findr-amber" />
              </div>
            ) : detail?.trailerKey ? (
              <div className="w-full aspect-video rounded-xl overflow-hidden border border-findr-border shadow-sm bg-black">
                <iframe
                  className="w-full h-full"
                  src={`https://www.youtube.com/embed/${detail.trailerKey}?autoplay=0&rel=0`}
                  title="Trailer"
                  allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture"
                  allowFullScreen
                />
              </div>
            ) : (
              <div className="flex flex-col items-center justify-center py-12 text-center rounded-xl border border-findr-border bg-white">
                <Film className="size-10 text-findr-tertiary/40 mb-3" />
                <p className="text-sm font-medium text-findr-secondary">
                  No trailer available
                </p>
              </div>
            )}
          </div>
        </div>
      </DialogContent>
    </Dialog>
  )
}
