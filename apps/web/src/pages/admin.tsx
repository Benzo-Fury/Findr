import * as React from "react"
import {
  ArrowClockwiseIcon,
  BooksIcon,
  DownloadSimpleIcon,
  HeartbeatIcon,
  PlayCircleIcon,
  WarningCircleIcon,
  type Icon,
} from "@phosphor-icons/react"
import { ADMIN_RANGE_DAYS, type AdminHealth, type AdminRange, type AdminStats } from "@findr/types/admin"
import type { NowPlayingRecord } from "@findr/types/playback"
import { fetchAdminHealth, fetchAdminStats, fetchNowPlaying } from "@/lib/api"
import { usePlayback } from "@/lib/playback"
import { useIsPhone } from "@/lib/responsive"
import { cardKey, useTitleCards } from "@/lib/title-cards"
import { cn } from "@/lib/utils"
import { Button } from "@/components/ui/button"
import { EmptyState } from "@/components/ui/empty-state"
import { PageHeader } from "@/components/ui/page-header"
import { Segmented } from "@/components/ui/segmented"
import { Skeleton } from "@/components/ui/skeleton"
import { DownloadsSection } from "@/components/admin/downloads-section"
import { LibrarySection } from "@/components/admin/library-section"
import { PlaybackSection } from "@/components/admin/playback-section"
import { periodDays } from "@/components/admin/series"
import { StorageHero } from "@/components/admin/storage-hero"
import { SystemSection } from "@/components/admin/system-section"

/**
 * The Admin page: how much room is left, how downloads are going, what the
 * library is made of, how it is watched, and whether everything Findr depends
 * on is healthy. Figures cover the chosen period; what plays now and the
 * services' health refresh while the page is open.
 */

const RANGES: { value: AdminRange; label: string; short: string }[] = [
  { value: "7d", label: "7 days", short: "7d" },
  { value: "30d", label: "30 days", short: "30d" },
  { value: "90d", label: "90 days", short: "90d" },
]

const SECTIONS: Array<{ id: string; label: string; icon: Icon }> = [
  { id: "downloads", label: "Downloads", icon: DownloadSimpleIcon },
  { id: "library", label: "Library", icon: BooksIcon },
  { id: "playback", label: "Playback", icon: PlayCircleIcon },
  { id: "system", label: "System", icon: HeartbeatIcon },
]

/** How far below the top of the window a section's heading counts as reached, under the pinned bars. */
const SECTION_OFFSET = 180

/** The section scrolled to: the last whose heading has passed under the pinned bars, or null above them all. */
function useCurrentSection(ids: string[], ready: boolean): string | null {
  const [current, setCurrent] = React.useState<string | null>(null)

  React.useEffect(() => {
    if (!ready) return
    let frame = 0
    const update = () => {
      frame = 0
      // At the very bottom the last section counts, even if its heading can't scroll that far up
      const bottom = window.innerHeight + window.scrollY >= document.documentElement.scrollHeight - 4
      const reached = ids.filter((id) => (document.getElementById(id)?.getBoundingClientRect().top ?? Infinity) <= SECTION_OFFSET)
      setCurrent(bottom ? (ids[ids.length - 1] ?? null) : (reached[reached.length - 1] ?? null))
    }
    const onScroll = () => {
      if (!frame) frame = requestAnimationFrame(update)
    }
    update()
    window.addEventListener("scroll", onScroll, { passive: true })
    window.addEventListener("resize", onScroll)
    return () => {
      cancelAnimationFrame(frame)
      window.removeEventListener("scroll", onScroll)
      window.removeEventListener("resize", onScroll)
    }
  }, [ids, ready])

  return current
}

const SECTION_IDS = SECTIONS.map((section) => section.id)

/** How often what plays now and the services' health refresh. */
const NOW_PLAYING_MS = 10_000
const HEALTH_MS = 60_000

/** While `active`, loads `load` now and every `intervalMs`, keeping the last good answer. */
function useLive<T>(load: (signal: AbortSignal) => Promise<T>, intervalMs: number, active = true): { data: T | null; failed: boolean } {
  const [data, setData] = React.useState<T | null>(null)
  const [failed, setFailed] = React.useState(false)

  React.useEffect(() => {
    if (!active) return
    const controller = new AbortController()
    const tick = () =>
      load(controller.signal).then(
        (next) => {
          setData(next)
          setFailed(false)
        },
        () => {
          if (!controller.signal.aborted) setFailed(true)
        },
      )
    void tick()
    const timer = setInterval(() => void tick(), intervalMs)
    return () => {
      controller.abort()
      clearInterval(timer)
    }
  }, [load, intervalMs, active])

  return { data, failed }
}

const loadNowPlaying = (signal: AbortSignal) => fetchNowPlaying({ signal })
const loadHealth = (signal: AbortSignal) => fetchAdminHealth({ signal })

export function AdminPage() {
  const [range, setRange] = React.useState<AdminRange>("30d")
  const phone = useIsPhone()
  const [stats, setStats] = React.useState<AdminStats | null>(null)
  const currentSection = useCurrentSection(SECTION_IDS, stats !== null)
  const [loading, setLoading] = React.useState(true)
  const [error, setError] = React.useState<string | null>(null)
  const [attempt, setAttempt] = React.useState(0)

  // The period's figures, kept on screen while the next period loads
  React.useEffect(() => {
    const controller = new AbortController()
    setLoading(true)
    fetchAdminStats(range, { signal: controller.signal })
      .then((next) => {
        setStats(next)
        setError(null)
      })
      .catch((reason: unknown) => {
        if (!controller.signal.aborted) setError(reason instanceof Error ? reason.message : "Could not load the figures")
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false)
      })
    return () => controller.abort()
  }, [range, attempt])

  // What plays now, asked only while playback is on
  const playback = usePlayback()
  const playbackOn = playback.ready && playback.enabled
  const nowPlaying = useLive<NowPlayingRecord[]>(loadNowPlaying, NOW_PLAYING_MS, playbackOn)
  const health = useLive<AdminHealth>(loadHealth, HEALTH_MS)

  // Names for every title the page mentions
  const keys = React.useMemo(() => {
    const titles = [...(stats?.library.largest ?? []), ...(stats?.playback.mostWatched ?? []), ...(nowPlaying.data ?? [])]
    return [...new Set(titles.map((title) => cardKey(title.mediaType, title.tmdbId)))]
  }, [stats, nowPlaying.data])
  const cards = useTitleCards(keys)

  const days = React.useMemo(() => periodDays(ADMIN_RANGE_DAYS[stats?.range ?? range], stats?.generatedAt), [stats, range])

  return (
    <div className="mx-auto max-w-[1600px] px-4 pb-24 md:px-8">
      <PageHeader title="Admin" />

      {!stats && error ? (
        <EmptyState
          icon={WarningCircleIcon}
          title="The figures didn't load"
          description={error}
          action={
            <Button onClick={() => setAttempt((value) => value + 1)}>
              <ArrowClockwiseIcon weight="bold" />
              Try again
            </Button>
          }
        />
      ) : !stats ? (
        <PageSkeleton />
      ) : (
        <>
          <StorageHero storage={stats.storage} />

          {/* Section jumps and the period, pinned under the top bar */}
          <nav
            aria-label="Admin sections"
            className="bleed-band sticky top-[var(--chrome-height)] z-[var(--z-chrome)] mt-10 flex items-center justify-between gap-3 py-3"
          >
            {/* On phones the sections are icons, the current one filled in ink */}
            <div className="scroll-x -mx-1 flex min-w-0 gap-1.5 px-1 py-0.5">
              {SECTIONS.map((section) => {
                const active = section.id === currentSection
                return (
                  <a
                    key={section.id}
                    href={`#${section.id}`}
                    aria-current={active ? "location" : undefined}
                    aria-label={section.label}
                    title={section.label}
                    onClick={(event) => {
                      event.preventDefault()
                      document.getElementById(section.id)?.scrollIntoView({ behavior: "smooth", block: "start" })
                      history.replaceState(history.state, "", `#${section.id}`)
                    }}
                    className={cn(
                      "flex size-9 shrink-0 items-center justify-center gap-1.5 rounded-full text-[0.8125rem] sm:h-8 sm:w-auto sm:px-3 font-semibold transition-[background-color,color,box-shadow,transform] duration-200 active:scale-95",
                      active ? "bg-ink text-surface" : "bg-surface text-ink-2 shadow-ring hover:text-ink hover:shadow-[0_0_0_1px_var(--color-line-strong)]",
                    )}
                  >
                    <section.icon aria-hidden weight={active ? "fill" : "bold"} className="size-4" />
                    <span className="hidden sm:inline">{section.label}</span>
                  </a>
                )
              })}
            </div>
            <Segmented
              label="Period"
              options={RANGES.map((option) => ({ value: option.value, label: phone ? option.short : option.label }))}
              value={range}
              onChange={setRange}
              size="sm"
              className="shrink-0"
            />
          </nav>

          {error && (
            <p role="status" className="mt-4 rounded-panel bg-bad-soft px-4 py-3 text-sm text-bad">
              Couldn't load that period: {error}
            </p>
          )}

          <div className={cn("transition-opacity duration-300", loading && "opacity-50")} aria-busy={loading}>
            <SectionHeading id="downloads" title="Downloads" />
            <DownloadsSection downloads={stats.downloads} days={days} />

            <SectionHeading id="library" title="Library" />
            <LibrarySection library={stats.library} cards={cards} />

            <SectionHeading id="playback" title="Playback" />
            <PlaybackSection playback={stats.playback} nowPlaying={playback.ready && (!playbackOn || nowPlaying.failed) ? null : (nowPlaying.data ?? [])} cards={cards} />
          </div>

          <SectionHeading id="system" title="System" />
          <SystemSection health={health.data} />
          {health.failed && !health.data && <p className="mt-4 text-sm text-bad">Couldn't check the services.</p>}
        </>
      )}
    </div>
  )
}

function SectionHeading({ id, title }: { id: string; title: string }) {
  return (
    <h2 id={id} className="display mb-6 mt-16 scroll-mt-36 text-5xl text-ink md:mt-24 md:text-6xl">
      {title}
    </h2>
  )
}

/** The page's shape while the first figures load. */
function PageSkeleton() {
  return (
    <div aria-busy className="mt-8 md:mt-12">
      <Skeleton className="h-28 w-3/4 max-w-xl rounded-panel sm:h-36" />
      <Skeleton className="mt-6 h-16 w-full rounded-art md:h-20" />
      <div className="mt-16 grid grid-cols-2 gap-6 lg:grid-cols-4">
        {Array.from({ length: 4 }, (_, index) => (
          <Skeleton key={index} className="h-20 rounded-panel" />
        ))}
      </div>
      <div className="mt-6 grid grid-cols-1 gap-4 lg:grid-cols-12">
        <Skeleton className="h-80 rounded-panel lg:col-span-8" />
        <Skeleton className="h-80 rounded-panel lg:col-span-4" />
      </div>
    </div>
  )
}
