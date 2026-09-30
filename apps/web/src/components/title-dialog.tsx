import * as React from "react"
import { X, Download, TriangleAlert, RefreshCw, MoreVertical, Trash2, Activity } from "lucide-react"
import { useNavigate } from "react-router-dom"
import type { DownloadDetail, DownloadSummary, TitleSummary } from "@findr/types/downloads"
import {
  createDownload,
  deleteTitle,
  fetchDownload,
  fetchTMDBDetails,
  lookupTitle,
  retryDownload,
} from "@/lib/api"
import { DOWNLOAD_STATUS, FINISHED_STATUSES } from "@/lib/download-status"
import type { PosterItem } from "@/lib/types"
import { cn } from "@/lib/utils"
import { CandidateList } from "@/components/candidate-list"
import { MediaCard } from "@/components/media-card"
import { StatusBadge } from "@/components/status-badge"
import { TorrentText } from "@/components/torrent-text"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Dialog, DialogContent } from "@/components/ui/dialog"
import { Skeleton } from "@/components/ui/skeleton"

/**
 * The full-screen view of a single title: artwork, metadata, trailer, and
 * whatever Findr has done with it.
 *
 * The dialog asks the API whether this title has been requested. For the
 * movie, or the selected season of a show, the latest download decides the
 * primary action — start a download, follow one in progress, or retry one
 * that failed — and a finished download's releases can be hand-picked.
 */

const BACKDROP_BASE = "https://image.tmdb.org/t/p/w1280"
const POSTER_BASE = "https://image.tmdb.org/t/p/w342"

/** A title released within this window may not have good torrents yet. */
const RECENT_RELEASE_MS = 30 * 24 * 60 * 60 * 1000

interface Video {
  key: string
  site: string
  type: string
  official: boolean
}

interface CastMember {
  name: string
  character: string
  profile_path: string | null
}

interface Recommendation {
  id: number
  title?: string
  name?: string
  media_type: string
  poster_path: string | null
  vote_average: number
  release_date?: string
  first_air_date?: string
}

interface TitleDialogProps {
  item: PosterItem
  onClose: () => void
  onItemClick: (item: PosterItem) => void
}

export function TitleDialog({ item, onClose, onItemClick }: TitleDialogProps) {
  const navigate = useNavigate()
  const [details, setDetails] = React.useState<Record<string, unknown> | null>(null)
  const [requested, setRequested] = React.useState<TitleSummary | null>(null)
  const [loaded, setLoaded] = React.useState(false)
  const [working, setWorking] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)
  const [season, setSeason] = React.useState(1)
  const [releases, setReleases] = React.useState<DownloadDetail | null>(null)
  const [showMenu, setShowMenu] = React.useState(false)
  const [deleting, setDeleting] = React.useState(false)
  const [tryingId, setTryingId] = React.useState<string | null>(null)
  const contentRef = React.useRef<HTMLDivElement>(null)
  const menuRef = React.useRef<HTMLDivElement>(null)

  // Load TMDB details and whatever Findr has for this title
  React.useEffect(() => {
    setLoaded(false)
    setDetails(null)
    setRequested(null)
    setReleases(null)
    setError(null)
    setShowMenu(false)
    setDeleting(false)
    setTryingId(null)
    contentRef.current?.scrollTo(0, 0)

    const controller = new AbortController()
    const opts = { signal: controller.signal }

    Promise.all([fetchTMDBDetails(item.mediaType, item.id, opts), lookupTitle(item.id, item.mediaType, opts)])
      .then(([data, title]) => {
        setDetails(data)
        setRequested(title)
        // Open on the most recently requested season, if any
        const latestSeason = title?.downloads.find((download) => download.season !== null)?.season
        setSeason(latestSeason ?? 1)
      })
      .catch(() => {})
      .finally(() => {
        if (!controller.signal.aborted) setLoaded(true)
      })

    return () => controller.abort()
  }, [item.mediaType, item.id])

  // The latest download for the movie, or for the selected season
  const current: DownloadSummary | undefined = requested?.downloads.find((download) =>
    item.mediaType === "movie" ? true : download.season === season,
  )
  const isFinished = current ? FINISHED_STATUSES.includes(current.status) : false

  // Load the current download's releases so they can be hand-picked
  React.useEffect(() => {
    setReleases(null)
    if (!current) return
    const controller = new AbortController()
    fetchDownload(current.id, { signal: controller.signal })
      .then(setReleases)
      .catch(() => {})
    return () => controller.abort()
  }, [current?.id])

  React.useEffect(() => {
    if (!showMenu) return

    function handleClickOutside(e: MouseEvent) {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setShowMenu(false)
      }
    }

    document.addEventListener("mousedown", handleClickOutside)
    return () => document.removeEventListener("mousedown", handleClickOutside)
  }, [showMenu])

  /** Runs a download action, then shows its progress on the downloads page. */
  async function act(work: () => Promise<DownloadSummary>, failure: string) {
    setWorking(true)
    setError(null)
    try {
      const download = await work()
      onClose()
      navigate(`/downloads/${download.id}`)
    } catch (e) {
      setError(e instanceof Error ? e.message : failure)
      setWorking(false)
      setTryingId(null)
    }
  }

  function handleDownload() {
    act(
      () =>
        createDownload(
          item.mediaType === "tv"
            ? { tmdbId: item.id, mediaType: "tv", season }
            : { tmdbId: item.id, mediaType: "movie" },
        ),
      "Could not start the download",
    )
  }

  function handleRetry() {
    if (current) act(() => retryDownload(current.id), "Could not retry the download")
  }

  function handleTryRelease(candidateId: string) {
    if (!current) return
    setTryingId(candidateId)
    act(() => retryDownload(current.id, candidateId), "Could not start that release")
  }

  /** Forgets the title and its download history. Library files stay. */
  async function handleRemove() {
    if (!requested) return
    setDeleting(true)

    try {
      await deleteTitle(requested.id)
      onClose()
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not remove the title")
      setDeleting(false)
    }
  }

  const title = (details?.title || details?.name || item.title) as string
  const overview = (details?.overview || "") as string
  const releaseDate = (details?.release_date || details?.first_air_date || "") as string
  const runtime = details?.runtime as number | undefined
  const episodeRuntime = (details?.episode_run_time as number[] | undefined)?.[0]
  const displayRuntime = runtime || episodeRuntime
  const genres = (details?.genres || []) as { id: number; name: string }[]
  const voteAverage = (details?.vote_average || item.voteAverage) as number
  const numberOfSeasons = (details?.number_of_seasons || 1) as number
  const backdropPath = details?.backdrop_path as string | undefined
  const tagline = details?.tagline as string | undefined

  const videos = ((details?.videos as Record<string, unknown>)?.results || []) as Video[]
  const trailer =
    videos.find((v) => v.site === "YouTube" && v.type === "Trailer" && v.official) ||
    videos.find((v) => v.site === "YouTube" && v.type === "Trailer") ||
    videos.find((v) => v.site === "YouTube")

  const cast = ((details?.credits as Record<string, unknown>)?.cast || []) as CastMember[]
  const topCast = cast.slice(0, 6)

  const rawRecommendations = ((details?.recommendations as Record<string, unknown>)
    ?.results || []) as Recommendation[]

  const recommendations: PosterItem[] = rawRecommendations
    .filter((r) => r.poster_path)
    .slice(0, 20)
    .map((r) => ({
      id: r.id,
      mediaType: r.media_type === "tv" ? "tv" : "movie",
      title: r.title || r.name || "",
      posterPath: r.poster_path,
      voteAverage: r.vote_average,
      year: (r.release_date || r.first_air_date || "").slice(0, 4) || undefined,
    }))

  // Movie and season-pack releases; per-episode ones live on the downloads page
  const mainReleases = releases?.candidates.filter((candidate) => candidate.episodeId === null) ?? []

  const availabilityWarning = React.useMemo(() => {
    if (!details) return null

    // A movie still only in cinemas rarely has anything worth downloading
    if (item.mediaType === "movie") {
      const releaseDates = (
        details.release_dates as {
          results?: {
            iso_3166_1: string
            release_dates: { type: number; release_date: string }[]
          }[]
        }
      )?.results

      if (releaseDates) {
        const usRelease = releaseDates.find((r) => r.iso_3166_1 === "US")
        const releases = usRelease?.release_dates ?? releaseDates.flatMap((r) => r.release_dates)
        const now = new Date()

        const hasTheatrical = releases.some(
          (r) => (r.type === 2 || r.type === 3) && new Date(r.release_date) <= now,
        )
        const hasDigitalOrPhysical = releases.some(
          (r) => (r.type === 4 || r.type === 5) && new Date(r.release_date) <= now,
        )

        if (hasTheatrical && !hasDigitalOrPhysical) {
          return (
            <>
              This movie is currently only in cinemas. <TorrentText>Torrents</TorrentText> may
              be unavailable or low quality.
            </>
          )
        }
      }
    }

    const releaseDateStr = (details.release_date || details.first_air_date) as
      | string
      | undefined

    if (releaseDateStr) {
      const releaseTime = new Date(releaseDateStr).getTime()
      if (Date.now() - releaseTime < RECENT_RELEASE_MS && Date.now() >= releaseTime) {
        return (
          <>
            This title released very recently. <TorrentText>Torrents</TorrentText> may be
            unavailable or low quality.
          </>
        )
      }
    }

    return null
  }, [details, item.mediaType])

  return (
    <Dialog open onOpenChange={() => onClose()}>
      <DialogContent className="max-h-[90vh] max-w-4xl gap-0 overflow-hidden p-0">
        <div ref={contentRef} className="max-h-[90vh] overflow-y-auto">
          {!loaded ? (
            <DialogSkeleton onClose={onClose} />
          ) : (
            <>
              <div className="relative aspect-video w-full bg-muted">
                {backdropPath ? (
                  <img
                    src={`${BACKDROP_BASE}${backdropPath}`}
                    alt={title}
                    className="size-full object-cover"
                  />
                ) : null}

                <div className="absolute inset-0 bg-gradient-to-t from-background via-background/50 to-transparent" />

                <button
                  onClick={onClose}
                  className="absolute top-3 left-3 flex size-9 items-center justify-center rounded-full bg-black/60 text-white transition-all duration-200 hover:scale-110 hover:bg-black/80 active:scale-95"
                >
                  <X className="size-5" />
                </button>

                {requested && (
                  <div ref={menuRef} className="absolute top-3 right-3">
                    <button
                      onClick={() => setShowMenu((open) => !open)}
                      className="flex size-9 items-center justify-center rounded-full bg-black/60 text-white transition-all duration-200 hover:scale-110 hover:bg-black/80 active:scale-95"
                    >
                      <MoreVertical className="size-5" />
                    </button>

                    {showMenu && (
                      <div className="absolute right-0 mt-1 w-44 rounded-lg bg-popover p-1 shadow-xl ring-1 ring-border animate-in fade-in-0 zoom-in-95">
                        <button
                          onClick={handleRemove}
                          disabled={deleting}
                          title="Forget this title and its download history. Files in your library are kept."
                          className="flex w-full items-center gap-2 rounded-md px-3 py-2 text-sm text-red-500 transition-colors hover:bg-red-500/10 disabled:opacity-50"
                        >
                          <Trash2 className="size-4" />
                          {deleting ? "Removing..." : "Remove from library"}
                        </button>
                      </div>
                    )}
                  </div>
                )}

                <div className="absolute inset-x-0 bottom-0 flex items-end gap-5 p-6">
                  {item.posterPath && (
                    <img
                      src={`${POSTER_BASE}${item.posterPath}`}
                      alt={title}
                      className="hidden w-28 flex-shrink-0 rounded-lg border border-white/10 shadow-xl sm:block md:w-32"
                    />
                  )}

                  <div className="min-w-0 flex-1">
                    {current && (
                      <StatusBadge status={DOWNLOAD_STATUS[current.status]} className="mb-2 shadow-lg" />
                    )}

                    <h1 className="text-2xl font-bold text-foreground sm:text-3xl lg:text-4xl">
                      {title}
                    </h1>

                    {tagline && (
                      <p className="mt-1 text-sm italic text-muted-foreground">{tagline}</p>
                    )}

                    <div className="mt-4 flex flex-wrap items-center gap-3">
                      {current && !isFinished ? (
                        <Button onClick={() => { onClose(); navigate(`/downloads/${current.id}`) }} className="gap-2">
                          <Activity className="size-4" />
                          View progress
                        </Button>
                      ) : current && current.status !== "completed" ? (
                        <Button onClick={handleRetry} disabled={working} className="gap-2">
                          <RefreshCw className={cn("size-4", working && "animate-spin")} />
                          {working ? "Retrying..." : "Retry"}
                        </Button>
                      ) : (
                        <Button onClick={handleDownload} disabled={working} className="gap-2">
                          <Download className="size-4" />
                          {working ? "Starting..." : current ? "Download again" : "Download"}
                        </Button>
                      )}

                      {item.mediaType === "tv" && numberOfSeasons > 0 && (
                        <select
                          value={season}
                          onChange={(e) => setSeason(Number(e.target.value))}
                          className="rounded-lg border border-border bg-background px-3 py-2 text-sm"
                        >
                          {Array.from({ length: numberOfSeasons }, (_, i) => i + 1).map((s) => (
                            <option key={s} value={s}>
                              Season {s}
                              {requested?.downloads.some((download) => download.season === s) ? " ✓" : ""}
                            </option>
                          ))}
                        </select>
                      )}
                    </div>

                    {error && <p className="mt-2 text-sm text-red-400">{error}</p>}
                  </div>
                </div>
              </div>

              {availabilityWarning && (
                <div className="mx-6 mt-4 flex cursor-default items-start gap-3 rounded-lg border border-amber-500/20 bg-amber-500/10 px-4 py-3">
                  <TriangleAlert className="mt-0.5 size-4 flex-shrink-0 text-amber-600 dark:text-amber-400" />
                  <p className="text-sm text-amber-600 dark:text-amber-400">
                    {availabilityWarning}
                  </p>
                </div>
              )}

              <div className="p-6">
                <div className="grid grid-cols-1 gap-6 md:grid-cols-[1fr_auto]">
                  <div>
                    <div className="flex flex-wrap items-center gap-2 text-sm text-muted-foreground">
                      {releaseDate && (
                        <span className="font-medium text-foreground">
                          {releaseDate.slice(0, 4)}
                        </span>
                      )}
                      {item.mediaType === "tv" && numberOfSeasons > 0 && (
                        <span>
                          {numberOfSeasons} {numberOfSeasons === 1 ? "Season" : "Seasons"}
                        </span>
                      )}
                      {displayRuntime && <span>{displayRuntime}m</span>}
                      {voteAverage > 0 && (
                        <span className="flex items-center gap-1">
                          <span className="text-amber-400">&#9733;</span>
                          {voteAverage.toFixed(1)}
                        </span>
                      )}
                    </div>

                    {genres.length > 0 && (
                      <div className="mt-3 flex flex-wrap gap-1.5">
                        {genres.map((genre) => (
                          <Badge key={genre.id} variant="secondary">
                            {genre.name}
                          </Badge>
                        ))}
                      </div>
                    )}

                    {overview && (
                      <p className="mt-4 text-sm leading-relaxed text-muted-foreground">
                        {overview}
                      </p>
                    )}
                  </div>

                  {topCast.length > 0 && (
                    <div className="min-w-0 text-sm md:w-56">
                      <p className="text-muted-foreground">
                        <span className="text-muted-foreground/60">Cast: </span>
                        <span className="text-foreground">
                          {topCast.map((member) => member.name).join(", ")}
                        </span>
                      </p>
                      <p className="mt-2 text-muted-foreground">
                        <span className="text-muted-foreground/60">Genres: </span>
                        <span className="text-foreground">
                          {genres.map((genre) => genre.name).join(", ")}
                        </span>
                      </p>
                    </div>
                  )}
                </div>

                {trailer && (
                  <div className="mt-6">
                    <h3 className="mb-3 text-lg font-semibold">Trailer</h3>
                    <div className="aspect-video w-full overflow-hidden rounded-lg">
                      <iframe
                        src={`https://www.youtube.com/embed/${trailer.key}`}
                        title={`${title} trailer`}
                        className="size-full"
                        allow="accelerometer; clipboard-write; encrypted-media; gyroscope; picture-in-picture"
                        allowFullScreen
                      />
                    </div>
                  </div>
                )}

                {releases && (
                  <div className="mt-6">
                    <h3 className="mb-3 text-lg font-semibold">
                      <TorrentText>Releases</TorrentText>{" "}
                      <span className="text-sm font-normal text-muted-foreground">
                        ({mainReleases.length})
                      </span>
                    </h3>
                    <p className="mb-3 text-sm text-muted-foreground">
                      {isFinished
                        ? "Pick a different release to download it instead."
                        : "Releases being tried for this download."}
                    </p>
                    <CandidateList
                      candidates={mainReleases}
                      onTry={isFinished ? handleTryRelease : undefined}
                      tryingId={tryingId}
                      emptyLabel="No whole-season releases were found; episodes are fetched one by one."
                    />
                  </div>
                )}

                {recommendations.length > 0 && (
                  <div className="mt-6">
                    <h3 className="mb-3 text-lg font-semibold">More Like This</h3>
                    <div className="flex gap-3 overflow-x-auto pb-2 scrollbar-hide">
                      {recommendations.map((recommendation) => (
                        <div
                          key={`${recommendation.mediaType}-${recommendation.id}`}
                          className="w-32 flex-shrink-0 sm:w-36"
                        >
                          <MediaCard
                            title={recommendation.title}
                            year={recommendation.year}
                            posterPath={recommendation.posterPath}
                            mediaType={recommendation.mediaType}
                            rating={recommendation.voteAverage}
                            onClick={() => onItemClick(recommendation)}
                          />
                        </div>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            </>
          )}
        </div>
      </DialogContent>
    </Dialog>
  )
}

function DialogSkeleton({ onClose }: { onClose: () => void }) {
  return (
    <>
      <div className="relative aspect-video w-full">
        <Skeleton className="size-full rounded-none" />
        <button
          onClick={onClose}
          className="absolute top-3 left-3 flex size-9 items-center justify-center rounded-full bg-black/60 text-white transition-all duration-200 hover:scale-110 hover:bg-black/80 active:scale-95"
        >
          <X className="size-5" />
        </button>
        <div className="absolute inset-x-0 bottom-0 flex items-end gap-5 p-6">
          <Skeleton className="hidden h-40 w-28 flex-shrink-0 rounded-lg sm:block md:w-32" />
          <div className="min-w-0 flex-1 space-y-3">
            <Skeleton className="h-8 w-2/3" />
            <Skeleton className="h-4 w-1/3" />
            <Skeleton className="mt-4 h-10 w-28 rounded-md" />
          </div>
        </div>
      </div>

      <div className="p-6">
        <div className="flex items-center gap-3">
          <Skeleton className="h-4 w-10" />
          <Skeleton className="h-4 w-16" />
          <Skeleton className="h-4 w-10" />
        </div>
        <div className="mt-3 flex gap-2">
          {Array.from({ length: 4 }).map((_, i) => (
            <Skeleton key={i} className="h-6 w-20 rounded-full" />
          ))}
        </div>
        <div className="mt-4 space-y-2">
          <Skeleton className="h-4 w-full" />
          <Skeleton className="h-4 w-full" />
          <Skeleton className="h-4 w-3/4" />
        </div>
        <div className="mt-6">
          <Skeleton className="mb-3 h-6 w-24" />
          <Skeleton className="aspect-video w-full rounded-lg" />
        </div>
        <div className="mt-6">
          <Skeleton className="mb-3 h-6 w-32" />
          <div className="flex gap-3">
            {Array.from({ length: 5 }).map((_, i) => (
              <Skeleton key={i} className="h-48 w-32 flex-shrink-0 rounded-lg sm:w-36" />
            ))}
          </div>
        </div>
      </div>
    </>
  )
}
