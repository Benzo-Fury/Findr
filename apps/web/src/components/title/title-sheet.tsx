import * as React from "react"
import { useNavigate } from "react-router-dom"
import { AnimatePresence, motion } from "motion/react"
import {
  ArrowRightIcon,
  ArrowsClockwiseIcon,
  DotsThreeIcon,
  DownloadSimpleIcon,
  PlayIcon,
  StarIcon,
  TrashIcon,
  WarningIcon,
} from "@phosphor-icons/react"
import type { DownloadDetail, DownloadSummary } from "@findr/types/downloads"
import { createDownload, deleteTitle, fetchDownload, fetchTMDBDetails, retryDownload } from "@/lib/api"
import { ATTEMPT_PHASE, DOWNLOAD_STATUS, isActive } from "@/lib/download-status"
import { episodeCode, formatPercent, formatRuntime } from "@/lib/format"
import { useLibrary, type LibraryEntry } from "@/lib/library"
import { EASE_OUT, FADE, SPRING_SNAP, staggerDelay } from "@/lib/motion"
import { cardKey } from "@/lib/title-cards"
import { posterLayoutId, posterOriginFor, rememberPosterOrigin, type TitleRef } from "@/lib/title-route"
import { tmdbImage } from "@/lib/tmdb-image"
import { cn } from "@/lib/utils"
import { ReleaseList } from "@/components/downloads/release-list"
import { PosterCard } from "@/components/media/poster-card"
import { Button } from "@/components/ui/button"
import { Menu, MenuItem } from "@/components/ui/menu"
import { Poster } from "@/components/ui/poster"
import { ProgressBar } from "@/components/ui/progress-bar"
import { ScrollRow } from "@/components/ui/scroll-row"
import { Sheet, SheetClose } from "@/components/ui/sheet"
import { Skeleton } from "@/components/ui/skeleton"
import { StatusLabel } from "@/components/ui/status-label"
import { useToast } from "@/components/ui/toast"
import { readDetails, type SeasonInfo, type TitleDetails } from "@/components/title/title-details"

interface TitleSheetProps {
  titleRef: TitleRef | null
  onClose: () => void
  onOpenTitle: (ref: TitleRef) => void
}

/**
 * Everything about one title beside the way to get it. Opened from any page
 * through the URL. The top of the sheet always answers "do I have this, and
 * what do I press?": download, follow progress, or retry, per season for
 * shows. Details, releases, trailer, cast and similar titles follow.
 */
export function TitleSheet({ titleRef, onClose, onOpenTitle }: TitleSheetProps) {
  // Keep showing the last title while the sheet animates closed
  const [shown, setShown] = React.useState<TitleRef | null>(titleRef)
  React.useEffect(() => {
    if (titleRef) setShown(titleRef)
  }, [titleRef])

  const label = "Title details"

  return (
    <Sheet open={titleRef !== null} onClose={onClose} label={label}>
      {shown && <TitleBody key={`${shown.mediaType}:${shown.id}`} titleRef={shown} onOpenTitle={onOpenTitle} onClose={onClose} />}
    </Sheet>
  )
}

/* -------------------------------------------------------------------------- */
/* Body                                                                       */
/* -------------------------------------------------------------------------- */

interface TitleBodyProps {
  titleRef: TitleRef
  onOpenTitle: (ref: TitleRef) => void
  onClose: () => void
}

function TitleBody({ titleRef, onOpenTitle, onClose }: TitleBodyProps) {
  const { byKey, refresh } = useLibrary()
  const toast = useToast()
  const navigate = useNavigate()
  const key = cardKey(titleRef.mediaType, titleRef.id)
  const entry = byKey.get(key)
  const layoutId = React.useMemo(() => posterOriginFor(key), [key])

  const [details, setDetails] = React.useState<TitleDetails | null>(null)
  const [failed, setFailed] = React.useState(false)
  const [season, setSeason] = React.useState<number | null>(null)

  React.useEffect(() => {
    const controller = new AbortController()
    fetchTMDBDetails(titleRef.mediaType, titleRef.id, { signal: controller.signal })
      .then((raw) => setDetails(readDetails(raw, titleRef.mediaType)))
      .catch(() => {
        if (!controller.signal.aborted) setFailed(true)
      })
    return () => controller.abort()
  }, [titleRef.mediaType, titleRef.id])

  // Open on the most recently requested season, else the first
  const firstSeason = details?.seasons[0]?.number ?? 1
  const selectedSeason = season ?? entry?.title.downloads.find((download) => download.season !== null)?.season ?? firstSeason

  // The latest download for the movie, or for the selected season
  const current = entry?.title.downloads.find((download) => titleRef.mediaType === "movie" || download.season === selectedSeason)

  const title = details?.title ?? entry?.card?.title ?? ""
  const posterPath = details?.posterPath ?? entry?.card?.posterPath ?? null

  /** Forgets the title and its history; library files stay. */
  async function remove(target: LibraryEntry) {
    try {
      await deleteTitle(target.title.id)
      refresh()
      toast({ title: `Removed ${title || "title"}`, description: "Files in your library were kept." })
      onClose()
    } catch (error) {
      toast({ title: "Could not remove the title", description: error instanceof Error ? error.message : undefined, tone: "bad" })
    }
  }

  return (
    <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={FADE}>
      <Backdrop path={details?.backdropPath ?? entry?.card?.backdropPath ?? null} loading={!details && !failed}>
        <div className="absolute right-3 top-3 flex items-center gap-2 md:right-4 md:top-4">
          {entry && (
            <Menu
              trigger={
                <button
                  type="button"
                  aria-label="More actions"
                  className="flex size-10 items-center justify-center rounded-full bg-surface/85 text-ink shadow-lift backdrop-blur-md transition-transform hover:bg-surface active:scale-90"
                >
                  <DotsThreeIcon weight="bold" className="size-5" />
                </button>
              }
            >
              <MenuItem icon={TrashIcon} tone="danger" onClick={() => remove(entry)}>
                Remove from library
              </MenuItem>
            </Menu>
          )}
          <SheetClose tone="overlay" />
        </div>
      </Backdrop>

      <div className="relative px-5 pb-10 md:px-8">
        {/* Poster and title, the poster overlapping the backdrop */}
        <div className="-mt-20 flex items-end gap-4 md:-mt-24 md:gap-6">
          <Poster
            path={posterPath}
            title={title}
            size="posterLarge"
            eager
            layoutId={layoutId}
            className="w-28 shrink-0 shadow-float ring-4 ring-surface md:w-36"
          />
          <div className="min-w-0 pb-1">
            {current && <StatusLabel status={DOWNLOAD_STATUS[current.status]} variant="filled" className="mb-2" />}
            {title ? (
              <motion.h2
                initial={{ opacity: 0, y: 8 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ duration: 0.45, ease: EASE_OUT }}
                className="display text-[2.25rem] text-ink [overflow-wrap:anywhere] md:text-5xl"
              >
                {title}
              </motion.h2>
            ) : (
              <Skeleton className="h-10 w-56 rounded-full" />
            )}
          </div>
        </div>

        {details ? <Facts details={details} mediaType={titleRef.mediaType} /> : !failed && <Skeleton className="mt-4 h-4 w-64 rounded-full" />}

        {failed && !details && (
          <p className="mt-4 text-[0.9375rem] text-bad">TMDB did not answer for this title. Close the sheet and try again shortly.</p>
        )}

        <ActionPanel
          titleRef={titleRef}
          title={title}
          details={details}
          current={current}
          season={selectedSeason}
          onSeason={setSeason}
          entry={entry}
          onChanged={refresh}
          onViewProgress={(id) => navigate(`/downloads/${id}`)}
        />

        {details && <About details={details} />}

        {current && <Releases download={current} mediaType={titleRef.mediaType} onChanged={refresh} />}

        {details?.trailerKey && <Trailer videoKey={details.trailerKey} title={title} />}

        {details && details.cast.length > 0 && <Cast cast={details.cast} />}

        {details && details.recommendations.length > 0 && (
          <Section title="More like this">
            <ScrollRow label="More like this" trackClassName="-mx-5 gap-3 px-5 md:-mx-8 md:px-8">
              {details.recommendations.map((item) => {
                const itemKey = cardKey(item.mediaType, item.id)
                const id = posterLayoutId("similar", itemKey)
                return (
                  <div key={itemKey} className="w-32 shrink-0 snap-start md:w-36">
                    <PosterCard
                      title={item.title}
                      year={item.year}
                      mediaType={item.mediaType}
                      posterPath={item.posterPath}
                      rating={item.voteAverage}
                      layoutId={id}
                      onOpen={() => {
                        rememberPosterOrigin(id)
                        onOpenTitle({ mediaType: item.mediaType, id: item.id })
                      }}
                    />
                  </div>
                )
              })}
            </ScrollRow>
          </Section>
        )}
      </div>
    </motion.div>
  )
}

/* -------------------------------------------------------------------------- */
/* Scoped components                                                          */
/* -------------------------------------------------------------------------- */

interface BackdropProps {
  path: string | null
  loading: boolean
  children: React.ReactNode
}

/** Wide artwork across the top of the sheet, fading into the panel. */
function Backdrop({ path, loading, children }: BackdropProps) {
  const [loaded, setLoaded] = React.useState(false)
  const src = tmdbImage(path, "backdropLarge")

  return (
    <div className="relative aspect-[16/9] max-h-[19rem] w-full overflow-hidden bg-sunken">
      {(loading || (src && !loaded)) && <div className="skeleton absolute inset-0" />}
      {src && (
        <motion.img
          src={src}
          alt=""
          onLoad={() => setLoaded(true)}
          initial={{ opacity: 0, scale: 1.06 }}
          animate={loaded ? { opacity: 1, scale: 1 } : undefined}
          transition={{ duration: 0.9, ease: EASE_OUT }}
          className="absolute inset-0 size-full object-cover"
        />
      )}
      <div className="absolute inset-0 bg-gradient-to-t from-surface via-surface/30 to-transparent" />
      {children}
    </div>
  )
}

interface FactsProps {
  details: TitleDetails
  mediaType: TitleRef["mediaType"]
}

/** Year, runtime, rating, kind and genres in one scannable line. */
function Facts({ details, mediaType }: FactsProps) {
  const seasonCount = details.seasons.filter((season) => season.number > 0).length

  return (
    <div className="mt-4 flex flex-wrap items-center gap-x-4 gap-y-2 text-[0.875rem] text-ink-2">
      {details.year && <span className="font-mono font-medium text-ink tabular">{details.year}</span>}
      <span>{mediaType === "tv" ? (seasonCount === 1 ? "Series, 1 season" : `Series, ${seasonCount} seasons`) : "Film"}</span>
      {details.runtime && <span className="font-mono tabular">{formatRuntime(details.runtime)}</span>}
      {details.rating > 0 && (
        <span className="inline-flex items-center gap-1 font-mono tabular">
          <StarIcon aria-hidden weight="fill" className="size-3.5 text-signal-strong" />
          {details.rating.toFixed(1)}
        </span>
      )}
      {details.genres.length > 0 && <span className="text-ink-3">{details.genres.slice(0, 3).join(", ")}</span>}
    </div>
  )
}

interface ActionPanelProps {
  titleRef: TitleRef
  title: string
  details: TitleDetails | null
  current: DownloadSummary | undefined
  season: number
  onSeason: (season: number) => void
  entry: LibraryEntry | undefined
  onChanged: () => void
  onViewProgress: (downloadId: string) => void
}

/**
 * The part of the sheet that acts: pick a season, then download, follow,
 * retry or fetch again, depending on what the latest download did.
 */
function ActionPanel({ titleRef, title, details, current, season, onSeason, entry, onChanged, onViewProgress }: ActionPanelProps) {
  const toast = useToast()
  const [working, setWorking] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)
  const isShow = titleRef.mediaType === "tv"
  const running = current ? isActive(current.status) : false
  const what = isShow ? `${title}, season ${season}` : title

  React.useEffect(() => setError(null), [season])

  /** Runs a download action and confirms it without leaving the sheet. */
  async function act(work: () => Promise<DownloadSummary>, done: string) {
    setWorking(true)
    setError(null)
    try {
      const download = await work()
      onChanged()
      toast({ title: done, description: what, action: { label: "View", onClick: () => onViewProgress(download.id) } })
    } catch (e) {
      setError(e instanceof Error ? e.message : "That did not work. Try again.")
    } finally {
      setWorking(false)
    }
  }

  const start = () =>
    act(
      () => createDownload(isShow ? { tmdbId: titleRef.id, mediaType: "tv", season } : { tmdbId: titleRef.id, mediaType: "movie" }),
      "Download queued",
    )
  const retry = () => current && act(() => retryDownload(current.id), "Retrying")

  return (
    <section aria-label="Get this title" className="mt-6 rounded-panel bg-paper p-4 shadow-ring md:p-5">
      {isShow && details && details.seasons.length > 0 && (
        <SeasonPicker seasons={details.seasons} selected={season} onSelect={onSeason} entry={entry} />
      )}

      <AnimatePresence mode="wait" initial={false}>
        <motion.div
          key={`${season}-${current?.id ?? "none"}-${running}`}
          initial={{ opacity: 0, y: 6 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, y: -4 }}
          transition={{ duration: 0.22, ease: EASE_OUT }}
        >
          {running && current ? (
            <LiveProgress download={current} onView={() => onViewProgress(current.id)} />
          ) : (
            <div className="flex flex-wrap items-center gap-3">
              {!current && (
                <Button variant="signal" size="lg" icon={DownloadSimpleIcon} loading={working} onClick={start} disabled={!details}>
                  {isShow ? `Download season ${season}` : "Download"}
                </Button>
              )}
              {current && current.status !== "completed" && (
                <Button variant="signal" size="lg" icon={ArrowsClockwiseIcon} loading={working} onClick={retry}>
                  Retry
                </Button>
              )}
              {current?.status === "completed" && (
                <Button variant="outline" size="lg" icon={DownloadSimpleIcon} loading={working} onClick={start}>
                  Download again
                </Button>
              )}
              {current && (
                <Button variant="ghost" iconEnd={ArrowRightIcon} onClick={() => onViewProgress(current.id)}>
                  Details
                </Button>
              )}
            </div>
          )}
          {current && !running && current.statusMessage && current.status !== "completed" && (
            <p className="mt-3 text-[0.875rem] leading-relaxed text-ink-2">{current.statusMessage}</p>
          )}
        </motion.div>
      </AnimatePresence>

      {error && (
        <p role="alert" className="mt-3 text-[0.875rem] font-medium text-bad">
          {error}
        </p>
      )}

      {details?.availabilityWarning && !current && (
        <p className="mt-4 flex items-start gap-2 text-[0.8125rem] leading-relaxed text-warn">
          <WarningIcon aria-hidden weight="bold" className="mt-0.5 size-4 shrink-0" />
          {details.availabilityWarning}
        </p>
      )}
    </section>
  )
}

interface SeasonPickerProps {
  seasons: SeasonInfo[]
  selected: number
  onSelect: (season: number) => void
  entry: LibraryEntry | undefined
}

/** Seasons as a row of pills, each marked with what Findr has done with it. */
function SeasonPicker({ seasons, selected, onSelect, entry }: SeasonPickerProps) {
  return (
    <div className="mb-4">
      <p className="mb-2 text-micro font-semibold text-ink-3">Season</p>
      <div role="radiogroup" aria-label="Season" className="scroll-x -mx-1 flex gap-1.5 px-1 pb-1">
        {seasons.map((season) => {
          const download = entry?.title.downloads.find((item) => item.season === season.number)
          const status = download ? DOWNLOAD_STATUS[download.status] : null
          const active = season.number === selected
          const StatusIcon = status?.icon
          return (
            <button
              key={season.number}
              type="button"
              role="radio"
              aria-checked={active}
              aria-label={`${season.name}${status ? `, ${status.label}` : ""}`}
              title={season.episodes ? `${season.name}, ${season.episodes} episodes` : season.name}
              onClick={() => onSelect(season.number)}
              className={cn(
                "relative inline-flex h-9 shrink-0 items-center gap-1.5 rounded-full px-3.5 font-mono text-[0.8125rem] font-semibold tabular transition-colors duration-200",
                active ? "text-surface" : "bg-surface text-ink-2 shadow-ring hover:text-ink",
              )}
            >
              {active && <motion.span layoutId="season-marker" transition={SPRING_SNAP} className="absolute inset-0 rounded-full bg-ink" />}
              <span className="relative">{season.number === 0 ? "Specials" : `S${String(season.number).padStart(2, "0")}`}</span>
              {StatusIcon && status && (
                <StatusIcon
                  aria-hidden
                  weight="bold"
                  className={cn("relative size-3.5", active ? "text-signal" : status.tone === "ok" ? "text-ok" : status.tone === "bad" ? "text-bad" : "text-ink-3", status.animated && "animate-[spin_1.6s_linear_infinite]")}
                />
              )}
            </button>
          )
        })}
      </div>
    </div>
  )
}

interface LiveProgressProps {
  download: DownloadSummary
  onView: () => void
}

/** The running download's phase and progress, updated by the shared poll. */
function LiveProgress({ download, onView }: LiveProgressProps) {
  const attempt = download.activeAttempt
  const phase = attempt ? ATTEMPT_PHASE[attempt.phase] : DOWNLOAD_STATUS[download.status].label

  return (
    <div>
      <div className="flex items-end justify-between gap-4">
        <div className="min-w-0">
          <p className="text-[0.9375rem] font-semibold text-ink">
            {attempt?.episodeNumber != null && download.season !== null && (
              <span className="mr-2 font-mono text-ink-2">{episodeCode(download.season, attempt.episodeNumber)}</span>
            )}
            {phase}
          </p>
          {attempt && <p className="mt-0.5 truncate font-mono text-micro text-ink-3">{attempt.candidateTitle}</p>}
        </div>
        <span className="display text-4xl text-ink tabular">{attempt ? formatPercent(attempt.progress) : "..."}</span>
      </div>
      <ProgressBar value={attempt?.progress} label="Download progress" size="md" className="mt-3" />
      <Button variant="outline" size="sm" iconEnd={ArrowRightIcon} onClick={onView} className="mt-4">
        Follow in Downloads
      </Button>
    </div>
  )
}

interface AboutProps {
  details: TitleDetails
}

function About({ details }: AboutProps) {
  if (!details.overview && !details.tagline) return null
  return (
    <section className="mt-8">
      {details.tagline && <p className="heading mb-2 text-xl text-ink">{details.tagline}</p>}
      {details.overview && <p className="max-w-[65ch] text-[0.9375rem] leading-relaxed text-ink-2">{details.overview}</p>}
    </section>
  )
}

interface ReleasesProps {
  download: DownloadSummary
  mediaType: TitleRef["mediaType"]
  onChanged: () => void
}

/** The current download's movie or season-pack releases, re-read as it runs. */
function Releases({ download, mediaType, onChanged }: ReleasesProps) {
  const toast = useToast()
  const [detail, setDetail] = React.useState<DownloadDetail | null>(null)
  const [tryingId, setTryingId] = React.useState<string | null>(null)
  const running = isActive(download.status)

  // Re-read when the download changes state, so finished runs show their outcome
  React.useEffect(() => {
    const controller = new AbortController()
    fetchDownload(download.id, { signal: controller.signal })
      .then(setDetail)
      .catch(() => {})
    return () => controller.abort()
  }, [download.id, download.status, download.updatedAt])

  async function tryRelease(candidateId: string) {
    setTryingId(candidateId)
    try {
      await retryDownload(download.id, candidateId)
      onChanged()
      toast({ title: "Trying that release first" })
    } catch (error) {
      toast({ title: "Could not start that release", description: error instanceof Error ? error.message : undefined, tone: "bad" })
    } finally {
      setTryingId(null)
    }
  }

  const main = detail?.candidates.filter((candidate) => candidate.episodeId === null) ?? []

  return (
    <Section title="Releases" count={detail ? main.length : undefined}>
      <p className="mb-3 text-[0.875rem] text-ink-2">
        {running ? "Releases being tried for this download." : "Pick a different release to try it first."}
      </p>
      {detail ? (
        <ReleaseList
          candidates={main}
          onTry={running ? undefined : tryRelease}
          tryingId={tryingId}
          emptyLabel={mediaType === "tv" ? "No whole-season releases were found, so episodes are fetched one by one." : "No releases found yet."}
        />
      ) : (
        <div className="space-y-2">
          <Skeleton className="h-24 w-full rounded-[0.875rem]" />
          <Skeleton className="h-24 w-full rounded-[0.875rem]" />
        </div>
      )}
    </Section>
  )
}

interface TrailerProps {
  videoKey: string
  title: string
}

/** A still that becomes the trailer when pressed, so the player never loads unasked. */
function Trailer({ videoKey, title }: TrailerProps) {
  const [playing, setPlaying] = React.useState(false)

  return (
    <Section title="Trailer">
      <div className="relative aspect-video overflow-hidden rounded-art bg-ink">
        {playing ? (
          <iframe
            src={`https://www.youtube-nocookie.com/embed/${videoKey}?autoplay=1&rel=0`}
            title={`${title} trailer`}
            allow="autoplay; encrypted-media; picture-in-picture"
            allowFullScreen
            className="absolute inset-0 size-full"
          />
        ) : (
          <button type="button" onClick={() => setPlaying(true)} aria-label={`Play the ${title} trailer`} className="group/play absolute inset-0">
            <img src={`https://i.ytimg.com/vi/${videoKey}/hqdefault.jpg`} alt="" loading="lazy" className="size-full object-cover opacity-90 transition-[opacity,transform] duration-500 ease-out-expo group-hover/play:scale-[1.03] group-hover/play:opacity-100" />
            <span className="absolute left-1/2 top-1/2 flex size-16 -translate-x-1/2 -translate-y-1/2 items-center justify-center rounded-full bg-signal text-ink shadow-float transition-transform duration-300 ease-out-expo group-hover/play:scale-110 group-active/play:scale-95">
              <PlayIcon weight="fill" className="ml-0.5 size-7" />
            </span>
          </button>
        )}
      </div>
    </Section>
  )
}

interface CastProps {
  cast: TitleDetails["cast"]
}

function Cast({ cast }: CastProps) {
  return (
    <Section title="Cast">
      <ScrollRow label="Cast" trackClassName="-mx-5 gap-4 px-5 md:-mx-8 md:px-8">
        {cast.map((member, index) => {
          const src = tmdbImage(member.profilePath, "profile")
          return (
            <motion.div
              key={`${member.name}-${index}`}
              initial={{ opacity: 0, y: 8 }}
              whileInView={{ opacity: 1, y: 0 }}
              viewport={{ once: true }}
              transition={{ ...FADE, delay: staggerDelay(index) }}
              className="w-20 shrink-0 snap-start text-center"
            >
              <div className="mx-auto size-20 overflow-hidden rounded-full bg-sunken">
                {src && <img src={src} alt="" loading="lazy" className="size-full object-cover" />}
              </div>
              <p className="mt-2 line-clamp-2 text-micro font-semibold leading-tight text-ink">{member.name}</p>
              <p className="mt-0.5 line-clamp-1 text-micro text-ink-3">{member.character}</p>
            </motion.div>
          )
        })}
      </ScrollRow>
    </Section>
  )
}

interface SectionProps {
  title: string
  count?: number
  children: React.ReactNode
}

function Section({ title, count, children }: SectionProps) {
  return (
    <section className="mt-9">
      <h3 className="heading mb-3 flex items-baseline gap-2 text-xl text-ink">
        {title}
        {count !== undefined && <span className="font-mono text-sm font-medium text-ink-3 tabular">{count}</span>}
      </h3>
      {children}
    </section>
  )
}
