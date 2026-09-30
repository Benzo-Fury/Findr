import * as React from "react"
import { X, Download, TriangleAlert, RefreshCw, MoreVertical, Trash2 } from "lucide-react"
import { useNavigate } from "react-router-dom"
import { Dialog, DialogContent } from "@/components/ui/dialog"
import { MediaCard } from "@/components/media-card"
import { Skeleton } from "@/components/ui/skeleton"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { TorrentText } from "@/components/torrent-text"
import {
  createJob,
  deleteIndex,
  fetchTMDBDetails,
  lookupIndexes,
  redownload,
  reindex,
} from "@/lib/api"
import type { IndexWithTorrents, PosterItem, Torrent } from "@/lib/types"
import { cn } from "@/lib/utils"

/**
 * The full-screen view of a single title: artwork, metadata, trailer, and
 * whatever Findr has stored for it.
 *
 * The dialog resolves a TMDB id to an IMDb id, then asks whether that title is
 * already indexed. That answer decides what the primary action does — queue a
 * new job, or offer to re-index and swap the chosen torrent.
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
  const [indexes, setIndexes] = React.useState<IndexWithTorrents[]>([])
  const [status, setStatus] = React.useState<"loading" | "indexed" | "not-indexed">("loading")
  const [working, setWorking] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)
  const [season, setSeason] = React.useState(1)
  const [activeSeason, setActiveSeason] = React.useState<number | null>(null)
  const [showMenu, setShowMenu] = React.useState(false)
  const [deleting, setDeleting] = React.useState(false)
  const [switchingTo, setSwitchingTo] = React.useState<string | null>(null)
  const contentRef = React.useRef<HTMLDivElement>(null)
  const menuRef = React.useRef<HTMLDivElement>(null)

  React.useEffect(() => {
    setStatus("loading")
    setDetails(null)
    setIndexes([])
    setError(null)
    setSeason(1)
    setActiveSeason(null)
    setShowMenu(false)
    setDeleting(false)
    setSwitchingTo(null)
    contentRef.current?.scrollTo(0, 0)

    const controller = new AbortController()
    const opts = { signal: controller.signal }

    async function load() {
      try {
        const data = await fetchTMDBDetails(item.mediaType, item.id, opts)
        setDetails(data)

        const imdbId = (data.imdb_id ||
          (data.external_ids as Record<string, unknown>)?.imdb_id) as string | undefined

        if (!imdbId) {
          setStatus("not-indexed")
          return
        }

        const found = await lookupIndexes(imdbId, opts)

        if (found.length > 0) {
          setIndexes(found)
          setActiveSeason(found[0]?.season ?? null)
          setStatus("indexed")
        } else {
          setStatus("not-indexed")
        }
      } catch {
        if (!controller.signal.aborted) setStatus("not-indexed")
      }
    }

    load()
    return () => controller.abort()
  }, [item.mediaType, item.id])

  const isIndexed = status === "indexed"
  const currentIndex = indexes.find((index) => index.season === activeSeason) ?? indexes[0]
  const torrents = currentIndex?.torrents ?? []
  const selectedTorrentId = currentIndex?.sourceId ?? null

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

  /** Reads the IMDb id off the loaded details, wherever TMDB put it. */
  function imdbIdOf(data: Record<string, unknown>): string | undefined {
    return (data.imdb_id || (data.external_ids as Record<string, unknown>)?.imdb_id) as
      | string
      | undefined
  }

  async function handleDeleteIndex() {
    if (!currentIndex) return
    setDeleting(true)

    try {
      // Every season of this title goes, not just the one on screen
      for (const index of indexes) await deleteIndex(index.id)
      onClose()
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to delete index")
      setDeleting(false)
    }
  }

  async function handleIndex() {
    if (!details) return
    setWorking(true)
    setError(null)

    try {
      const imdbId = imdbIdOf(details)
      if (!imdbId) {
        setError("Could not find an IMDb ID for this title.")
        setWorking(false)
        return
      }

      await createJob(imdbId, item.mediaType === "tv" ? season : undefined)
      onClose()
      navigate("/jobs")
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to create job")
      setWorking(false)
    }
  }

  async function handleReindex() {
    if (!currentIndex) return
    setWorking(true)
    setError(null)

    try {
      await reindex(currentIndex.id)
      onClose()
      navigate("/jobs")
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to re-index")
      setWorking(false)
    }
  }

  /** Repoints the index at another torrent and queues the download again. */
  async function handleSwitchTorrent(torrentId: string) {
    if (!currentIndex || torrentId === selectedTorrentId) return
    setSwitchingTo(torrentId)
    setError(null)

    try {
      await redownload(currentIndex.id, torrentId)
      onClose()
      navigate("/jobs")
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to switch torrent")
      setSwitchingTo(null)
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
          {status === "loading" ? (
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

                {isIndexed && (
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
                          onClick={handleDeleteIndex}
                          disabled={deleting}
                          className="flex w-full items-center gap-2 rounded-md px-3 py-2 text-sm text-red-500 transition-colors hover:bg-red-500/10 disabled:opacity-50"
                        >
                          <Trash2 className="size-4" />
                          {deleting ? "Deleting..." : "Delete Index"}
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
                    {isIndexed && (
                      <span className="mb-2 inline-flex items-center gap-1.5 rounded-full bg-emerald-500/90 px-3 py-1 text-xs font-semibold text-white shadow-lg backdrop-blur-sm">
                        <span className="size-1.5 animate-pulse rounded-full bg-white" />
                        Indexed
                      </span>
                    )}

                    <h1 className="text-2xl font-bold text-foreground sm:text-3xl lg:text-4xl">
                      {title}
                    </h1>

                    {tagline && (
                      <p className="mt-1 text-sm italic text-muted-foreground">{tagline}</p>
                    )}

                    <div className="mt-4 flex flex-wrap items-center gap-3">
                      {isIndexed ? (
                        <Button
                          onClick={handleReindex}
                          disabled={working}
                          variant="outline"
                          className="gap-2"
                        >
                          <RefreshCw className={cn("size-4", working && "animate-spin")} />
                          {working ? "Re-indexing..." : "Re-Index"}
                        </Button>
                      ) : (
                        <Button onClick={handleIndex} disabled={working} className="gap-2">
                          <Download className="size-4" />
                          {working ? "Creating..." : "Index"}
                        </Button>
                      )}

                      {!isIndexed && item.mediaType === "tv" && numberOfSeasons > 0 && (
                        <select
                          value={season}
                          onChange={(e) => setSeason(Number(e.target.value))}
                          className="rounded-lg border border-border bg-background px-3 py-2 text-sm"
                        >
                          {Array.from({ length: numberOfSeasons }, (_, i) => i + 1).map((s) => (
                            <option key={s} value={s}>
                              Season {s}
                            </option>
                          ))}
                        </select>
                      )}

                      {isIndexed && indexes.length > 1 && (
                        <select
                          value={activeSeason ?? ""}
                          onChange={(e) => {
                            const value = e.target.value
                            setActiveSeason(value === "" ? null : Number(value))
                          }}
                          className="rounded-lg border border-border bg-background px-3 py-2 text-sm"
                        >
                          {indexes.map((index) => (
                            <option key={index.id} value={index.season ?? ""}>
                              {index.season === null ? "Movie" : `Season ${index.season}`}
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

                {isIndexed && (
                  <div className="mt-6">
                    <h3 className="mb-3 text-lg font-semibold">
                      Torrents{" "}
                      {torrents.length > 0 && (
                        <span className="text-sm font-normal text-muted-foreground">
                          ({torrents.length})
                        </span>
                      )}
                    </h3>

                    {torrents.length === 0 ? (
                      <p className="text-sm text-muted-foreground">
                        No torrents stored for this index.
                      </p>
                    ) : (
                      <>
                        <p className="mb-3 text-sm text-muted-foreground">
                          Pick a different release to download it instead.
                        </p>
                        <div className="space-y-2">
                          {torrents.map((torrent) => (
                            <TorrentRow
                              key={torrent.id}
                              torrent={torrent}
                              isSelected={torrent.id === selectedTorrentId}
                              isSwitching={switchingTo === torrent.id}
                              disabled={switchingTo !== null}
                              onClick={() => handleSwitchTorrent(torrent.id)}
                            />
                          ))}
                        </div>
                      </>
                    )}
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

interface TorrentRowProps {
  torrent: Torrent
  isSelected: boolean
  isSwitching: boolean
  disabled: boolean
  onClick: () => void
}

function TorrentRow({ torrent, isSelected, isSwitching, disabled, onClick }: TorrentRowProps) {
  const sizeDisplay =
    torrent.sizeMB >= 1024
      ? `${(torrent.sizeMB / 1024).toFixed(1)} GB`
      : `${torrent.sizeMB} MB`

  return (
    <button
      onClick={onClick}
      disabled={disabled || isSelected}
      className={cn(
        "w-full rounded-lg border p-4 text-left transition-colors",
        isSelected ? "border-primary bg-primary/5" : "border-border hover:bg-muted/50",
        disabled && !isSwitching && "opacity-60",
      )}
    >
      <p className="truncate text-sm font-medium">{torrent.title}</p>

      <div className="mt-2 flex flex-wrap items-center gap-1.5">
        {torrent.resolution && <Badge variant="secondary">{torrent.resolution}</Badge>}
        {torrent.videoCodec && <Badge variant="secondary">{torrent.videoCodec}</Badge>}
        {torrent.audioCodec && <Badge variant="secondary">{torrent.audioCodec}</Badge>}
        {torrent.hdrFormat && torrent.hdrFormat !== "SDR" && (
          <Badge variant="info">{torrent.hdrFormat}</Badge>
        )}
        {torrent.releaseType && <Badge variant="outline">{torrent.releaseType}</Badge>}
        {isSelected && <Badge variant="default">Selected</Badge>}
        {isSwitching && <Badge variant="warning">Switching...</Badge>}
      </div>

      <div className="mt-2 flex items-center gap-3 text-xs text-muted-foreground">
        <span>{sizeDisplay}</span>
        <span>{torrent.seeders} seeders</span>
        <span>Score {torrent.score.toFixed(1)}</span>
        {torrent.uploaderName && <span className="truncate">{torrent.uploaderName}</span>}
      </div>
    </button>
  )
}
