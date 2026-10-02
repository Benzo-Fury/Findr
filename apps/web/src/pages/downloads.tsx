import * as React from "react"
import { useNavigate, useParams } from "react-router-dom"
import { AnimatePresence, motion } from "motion/react"
import { CaretRightIcon, ClockIcon, CompassIcon, DownloadSimpleIcon, ProhibitIcon } from "@phosphor-icons/react"
import type { DownloadStatus, DownloadSummary } from "@findr/types/downloads"
import { cancelDownload, fetchDownloads } from "@/lib/api"
import { ATTEMPT_PHASE, DOWNLOAD_STATUS } from "@/lib/download-status"
import { dayGroup, episodeCode, formatPercent, formatRelativeTime, plural } from "@/lib/format"
import { useInfiniteScroll } from "@/lib/hooks"
import { useLibrary } from "@/lib/library"
import { EASE_OUT, FADE, SPRING_PANEL, staggerDelay } from "@/lib/motion"
import { matchesAll, queryWords } from "@/lib/search"
import { cardKey, useTitleCards } from "@/lib/title-cards"
import { useTitleRoute } from "@/lib/title-route"
import { tmdbImage } from "@/lib/tmdb-image"
import type { TitleCard } from "@/lib/types"
import { cn } from "@/lib/utils"
import { DownloadSheet } from "@/components/downloads/download-sheet"
import { PhaseSteps } from "@/components/downloads/phase-steps"
import { Button } from "@/components/ui/button"
import { Chip } from "@/components/ui/chip"
import { EmptyState } from "@/components/ui/empty-state"
import { Highlight } from "@/components/ui/highlight"
import { PageHeader } from "@/components/ui/page-header"
import { Poster } from "@/components/ui/poster"
import { ProgressBar } from "@/components/ui/progress-bar"
import { SearchField } from "@/components/ui/search-field"
import { Skeleton } from "@/components/ui/skeleton"
import { StatusLabel } from "@/components/ui/status-label"
import { useToast } from "@/components/ui/toast"

/**
 * What is happening now, then everything that happened. Running downloads
 * lead the page as large live cards, queued ones follow, and the history
 * below is grouped by day, filterable by outcome and searchable by title.
 */

type HistoryFilter = "all" | Extract<DownloadStatus, "completed" | "partial" | "failed" | "cancelled">

const FILTERS: { value: HistoryFilter; label: string }[] = [
  { value: "all", label: "Everything" },
  { value: "completed", label: "In library" },
  { value: "partial", label: "Partial" },
  { value: "failed", label: "Failed" },
  { value: "cancelled", label: "Cancelled" },
]

const PAGE_SIZE = 50

export function DownloadsPage() {
  const { id: openId } = useParams<{ id: string }>()
  const navigate = useNavigate()
  const { openTitle } = useTitleRoute()
  const { active } = useLibrary()

  const running = active.filter((download) => download.status !== "queued")
  const queued = active.filter((download) => download.status === "queued").reverse()

  const history = useHistory(active)
  const keys = React.useMemo(
    () => [...active, ...history.items].map((download) => cardKey(download.mediaType, download.tmdbId)),
    [active, history.items],
  )
  const cardFor = useTitleCards(keys)
  const cardOf = (download: DownloadSummary) => cardFor(cardKey(download.mediaType, download.tmdbId))

  const openDownload = (download: DownloadSummary) => navigate(`/downloads/${download.id}`)

  return (
    <div className="mx-auto max-w-[1600px] px-4 md:px-8">
      <PageHeader title="Downloads" count={history.total === null ? undefined : history.total + active.length} />

      {/* Now */}
      <section aria-labelledby="now-heading" className="mt-8 md:mt-10">
        <h2 id="now-heading" className="heading mb-4 flex items-baseline gap-2 text-2xl text-ink">
          Now
          {running.length > 0 && <span className="font-mono text-sm font-medium text-ink-3 tabular">{running.length}</span>}
        </h2>
        <AnimatePresence initial={false} mode="popLayout">
          {running.length === 0 ? (
            <motion.div key="idle" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={FADE}>
              <IdleCard queued={queued.length} onDiscover={() => navigate("/discover")} />
            </motion.div>
          ) : (
            <motion.div key="live" layout className="grid gap-4 xl:grid-cols-2">
              <AnimatePresence initial={false}>
                {running.map((download) => (
                  <LiveCard key={download.id} download={download} card={cardOf(download)} onOpen={() => openDownload(download)} />
                ))}
              </AnimatePresence>
            </motion.div>
          )}
        </AnimatePresence>
      </section>

      {/* Up next */}
      <AnimatePresence initial={false}>
        {queued.length > 0 && (
          <motion.section
            aria-labelledby="queue-heading"
            initial={{ opacity: 0, height: 0 }}
            animate={{ opacity: 1, height: "auto" }}
            exit={{ opacity: 0, height: 0 }}
            transition={FADE}
            className="overflow-hidden"
          >
            <h2 id="queue-heading" className="heading mb-3 mt-10 flex items-baseline gap-2 text-xl text-ink">
              Up next
              <span className="font-mono text-sm font-medium text-ink-3 tabular">{queued.length}</span>
            </h2>
            <ol className="flex flex-col gap-1">
              {queued.map((download, index) => (
                <QueueRow key={download.id} position={index + 1} download={download} card={cardOf(download)} onOpen={() => openDownload(download)} />
              ))}
            </ol>
          </motion.section>
        )}
      </AnimatePresence>

      <History history={history} cardOf={cardOf} onOpen={openDownload} />

      <DownloadSheet downloadId={openId ?? null} onClose={() => navigate("/downloads")} onOpenTitle={openTitle} />
    </div>
  )
}

/* -------------------------------------------------------------------------- */
/* History data                                                               */
/* -------------------------------------------------------------------------- */

/**
 * Finished downloads, a page at a time, for one outcome filter. Re-read from
 * the top whenever something finishes, so the newest outcome appears at once.
 * `loadAll` fetches every remaining page, which a search needs.
 */
function useHistory(active: DownloadSummary[]) {
  const [filter, setFilter] = React.useState<HistoryFilter>("all")
  const [items, setItems] = React.useState<DownloadSummary[]>([])
  const [total, setTotal] = React.useState<number | null>(null)
  const [pages, setPages] = React.useState(1)
  const [loading, setLoading] = React.useState(true)
  const [loadingMore, setLoadingMore] = React.useState(false)
  const activeSignature = active.map((download) => download.id).join(",")

  React.useEffect(() => {
    const controller = new AbortController()
    fetchDownloads({ state: "finished", status: filter === "all" ? undefined : filter, page: 1, pageSize: Math.min(100, PAGE_SIZE * pages) }, { signal: controller.signal })
      .then(async (first) => {
        // Beyond 100 the API pages, so read the rest in page-sized steps
        let collected = first.items
        for (let page = 2; collected.length < Math.min(first.total, PAGE_SIZE * pages); page++) {
          const next = await fetchDownloads({ state: "finished", status: filter === "all" ? undefined : filter, page, pageSize: 100 }, { signal: controller.signal })
          if (next.items.length === 0) break
          collected = [...collected, ...next.items]
        }
        setItems(collected)
        setTotal(first.total)
      })
      .catch(() => {})
      .finally(() => {
        if (controller.signal.aborted) return
        setLoading(false)
        setLoadingMore(false)
      })
    return () => controller.abort()
  }, [filter, pages, activeSignature])

  const hasMore = total !== null && items.length < total

  const loadMore = React.useCallback(() => {
    setLoadingMore(true)
    setPages((current) => current + 1)
  }, [])

  const loadAll = React.useCallback(() => {
    if (total !== null && items.length < total) setPages(Math.ceil(total / PAGE_SIZE))
  }, [total, items.length])

  const changeFilter = React.useCallback((next: HistoryFilter) => {
    setFilter(next)
    setPages(1)
    setLoading(true)
  }, [])

  return { filter, setFilter: changeFilter, items, total, loading, loadingMore, hasMore, loadMore, loadAll }
}

/* -------------------------------------------------------------------------- */
/* Scoped components                                                          */
/* -------------------------------------------------------------------------- */

interface LiveCardProps {
  download: DownloadSummary
  card: TitleCard | undefined
  onOpen: () => void
}

/** A running download, large: its still, phase, percentage and release. */
function LiveCard({ download, card, onOpen }: LiveCardProps) {
  const toast = useToast()
  const { refresh } = useLibrary()
  const [cancelling, setCancelling] = React.useState(false)
  const attempt = download.activeAttempt
  const still = tmdbImage(card?.backdropPath, "backdrop")

  async function cancel(event: React.MouseEvent) {
    event.stopPropagation()
    setCancelling(true)
    try {
      await cancelDownload(download.id)
      refresh()
      toast({ title: "Download cancelled", description: card?.title })
    } catch (error) {
      toast({ title: "Could not cancel", description: error instanceof Error ? error.message : undefined, tone: "bad" })
      setCancelling(false)
    }
  }

  return (
    <motion.article
      layout
      initial={{ opacity: 0, y: 16, scale: 0.98 }}
      animate={{ opacity: 1, y: 0, scale: 1 }}
      exit={{ opacity: 0, scale: 0.97 }}
      transition={SPRING_PANEL}
      className="group/live relative overflow-hidden rounded-panel bg-surface shadow-ring transition-shadow duration-300 hover:shadow-lift"
    >
      <button type="button" onClick={onOpen} className="absolute inset-0 z-[1] rounded-panel" aria-label={`Open ${card?.title ?? "download"} details`} />
      <div className="grid sm:grid-cols-[13rem_minmax(0,1fr)] lg:grid-cols-[16rem_minmax(0,1fr)]">
        <div className="relative aspect-[16/9] bg-sunken sm:aspect-auto">
          {still && <img src={still} alt="" className="absolute inset-0 size-full object-cover transition-transform duration-700 ease-out-expo group-hover/live:scale-[1.04]" />}
          <div className="absolute inset-0 bg-gradient-to-t from-ink/40 to-transparent sm:bg-gradient-to-r sm:from-transparent sm:to-surface/10" />
        </div>
        <div className="flex min-w-0 flex-col p-4 md:p-5">
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <h3 className="heading truncate text-xl text-ink">{card?.title ?? "Loading"}</h3>
              <p className="mt-0.5 text-[0.8125rem] text-ink-2">
                {download.season !== null && <span className="font-mono">{episodeCode(download.season, attempt?.episodeNumber ?? null)} </span>}
                {attempt ? ATTEMPT_PHASE[attempt.phase] : DOWNLOAD_STATUS[download.status].label}
              </p>
            </div>
            <span className="display shrink-0 text-5xl text-ink tabular">{attempt ? formatPercent(attempt.progress) : "..."}</span>
          </div>
          <ProgressBar value={attempt?.progress} label={`${card?.title ?? "Download"} progress`} size="md" className="mt-4" />
          <PhaseSteps phase={attempt?.phase ?? null} className="mt-4" />
          <div className="mt-4 flex items-center justify-between gap-3">
            <p className="min-w-0 truncate font-mono text-micro text-ink-3" title={attempt?.candidateTitle}>
              {attempt?.candidateTitle ?? download.statusMessage ?? "Searching indexers for releases"}
            </p>
            <Button variant="ghost" size="sm" icon={ProhibitIcon} loading={cancelling} onClick={cancel} className="relative z-[2] shrink-0">
              Cancel
            </Button>
          </div>
        </div>
      </div>
    </motion.article>
  )
}

interface IdleCardProps {
  queued: number
  onDiscover: () => void
}

function IdleCard({ queued, onDiscover }: IdleCardProps) {
  return (
    <div className="flex flex-col items-start gap-4 rounded-panel bg-surface p-5 shadow-ring sm:flex-row sm:items-center sm:justify-between md:p-6">
      <div className="flex items-center gap-4">
        <span className="flex size-11 items-center justify-center rounded-full bg-sunken text-ink-2">
          <DownloadSimpleIcon weight="bold" className="size-5" />
        </span>
        <div>
          <p className="text-[0.9375rem] font-semibold text-ink">{queued > 0 ? "Starting the next download" : "Nothing is downloading"}</p>
          <p className="text-[0.8125rem] text-ink-2">{queued > 0 ? `${plural(queued, "download")} waiting in the queue.` : "Pick something on Discover and it will show up here."}</p>
        </div>
      </div>
      {queued === 0 && (
        <Button variant="outline" icon={CompassIcon} onClick={onDiscover}>
          Browse Discover
        </Button>
      )}
    </div>
  )
}

interface QueueRowProps {
  position: number
  download: DownloadSummary
  card: TitleCard | undefined
  onOpen: () => void
}

function QueueRow({ position, download, card, onOpen }: QueueRowProps) {
  return (
    <motion.li layout initial={{ opacity: 0, x: -8 }} animate={{ opacity: 1, x: 0 }} exit={{ opacity: 0 }} transition={FADE}>
      <button type="button" onClick={onOpen} className="flex w-full items-center gap-4 rounded-[0.875rem] px-2 py-2 text-left transition-colors hover:bg-surface hover:shadow-ring">
        <span className="w-6 text-center font-mono text-sm font-semibold text-ink-3 tabular">{position}</span>
        <Poster path={card?.posterPath} title={card?.title ?? ""} size="thumb" className="w-9 shrink-0 rounded-[0.375rem]" />
        <span className="min-w-0 flex-1">
          <span className="block truncate text-[0.9375rem] font-semibold text-ink">{card?.title ?? "Loading"}</span>
          <span className="block text-micro text-ink-3">{download.season !== null ? `Season ${download.season}` : "Film"}, queued {formatRelativeTime(download.createdAt)}</span>
        </span>
        <ClockIcon aria-hidden weight="bold" className="size-4 text-ink-3" />
      </button>
    </motion.li>
  )
}

interface HistoryProps {
  history: ReturnType<typeof useHistory>
  cardOf: (download: DownloadSummary) => TitleCard | undefined
  onOpen: (download: DownloadSummary) => void
}

/** Finished downloads by day, filterable by outcome and searchable by title. */
function History({ history, cardOf, onOpen }: HistoryProps) {
  const [query, setQuery] = React.useState("")
  const deferred = React.useDeferredValue(query)
  const words = React.useMemo(() => queryWords(deferred), [deferred])
  const sentinel = useInfiniteScroll(history.loadMore, history.hasMore && words.length === 0, history.loadingMore)
  const { loadAll } = history

  // A search covers the whole history, so fetch what is not loaded yet
  React.useEffect(() => {
    if (words.length > 0) loadAll()
  }, [words.length, loadAll])

  const visible = words.length === 0 ? history.items : history.items.filter((download) => matchesAll(cardOf(download)?.title ?? "", words))

  // Consecutive downloads sharing a calendar bucket form one group
  const groups: { label: string; items: DownloadSummary[] }[] = []
  for (const download of visible) {
    const label = dayGroup(download.updatedAt)
    const last = groups[groups.length - 1]
    if (last?.label === label) last.items.push(download)
    else groups.push({ label, items: [download] })
  }

  return (
    <section aria-labelledby="history-heading" className="mt-14 md:mt-16">
      <div className="bleed-band sticky top-[var(--chrome-height)] z-[2] flex flex-col gap-3 pb-3 pt-3 lg:flex-row lg:items-center">
        <h2 id="history-heading" className="heading flex items-baseline gap-2 text-2xl text-ink lg:mr-4">
          History
          {history.total !== null && <span className="font-mono text-sm font-medium text-ink-3 tabular">{history.total}</span>}
        </h2>
        <div className="scroll-x -mx-4 flex gap-2 px-4 lg:mx-0 lg:px-0">
          {FILTERS.map((filter) => (
            <Chip key={filter.value} selected={history.filter === filter.value} onClick={() => history.setFilter(filter.value)}>
              {filter.label}
            </Chip>
          ))}
        </div>
        <SearchField value={query} onChange={setQuery} label="Search history" shortcut="/" data-page-search className="lg:ml-auto lg:w-72" />
      </div>

      {history.loading ? (
        <div className="mt-4 space-y-2">
          {Array.from({ length: 8 }, (_, index) => (
            <Skeleton key={index} className="h-16 w-full rounded-[0.875rem]" />
          ))}
        </div>
      ) : visible.length === 0 ? (
        <EmptyState
          icon={ClockIcon}
          title={words.length ? "No downloads match" : "No history yet"}
          description={words.length ? "Try another title, or a different outcome." : "Finished downloads, good and bad, are listed here."}
        />
      ) : (
        <div className="mt-2">
          {groups.map((group) => (
            <div key={group.label} className="mt-6">
              <h3 className="mb-1 px-2 text-micro font-semibold text-ink-3">{group.label}</h3>
              <ul className="flex flex-col">
                {group.items.map((download, index) => (
                  <HistoryRow key={download.id} download={download} card={cardOf(download)} words={words} order={index} onOpen={() => onOpen(download)} />
                ))}
              </ul>
            </div>
          ))}
          {history.hasMore && words.length === 0 && <div ref={sentinel} aria-hidden className="h-px" />}
          {history.loadingMore && <Skeleton className="mt-3 h-16 w-full rounded-[0.875rem]" />}
        </div>
      )}
    </section>
  )
}

interface HistoryRowProps {
  download: DownloadSummary
  card: TitleCard | undefined
  words: string[]
  order: number
  onOpen: () => void
}

function HistoryRow({ download, card, words, order, onOpen }: HistoryRowProps) {
  const status = DOWNLOAD_STATUS[download.status]
  const problem = download.status === "failed" || download.status === "partial"

  return (
    <motion.li initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.3, ease: EASE_OUT, delay: staggerDelay(order) }}>
      <button
        type="button"
        onClick={onOpen}
        className="group/row flex w-full items-center gap-4 rounded-[0.875rem] px-2 py-2.5 text-left transition-colors duration-150 hover:bg-surface hover:shadow-ring"
      >
        <Poster path={card?.posterPath} title={card?.title ?? ""} size="thumb" className="w-10 shrink-0 rounded-[0.375rem]" />
        <span className="min-w-0 flex-1">
          <span className="block truncate text-[0.9375rem] font-semibold text-ink">
            {card ? <Highlight text={card.title} words={words} /> : "Loading"}
            {download.season !== null && <span className="ml-2 font-mono text-[0.8125rem] font-medium text-ink-2">S{String(download.season).padStart(2, "0")}</span>}
          </span>
          {problem && download.statusMessage ? (
            <span className="block truncate text-[0.8125rem] text-ink-2">{download.statusMessage}</span>
          ) : (
            <span className="block text-micro text-ink-3">{download.mediaType === "tv" ? "Series" : "Film"}{download.run > 1 ? `, run ${download.run}` : ""}</span>
          )}
        </span>
        <StatusLabel status={status} className="shrink-0 max-sm:text-micro" />
        <span className="hidden w-16 shrink-0 text-right font-mono text-micro text-ink-3 tabular md:block">{formatRelativeTime(download.updatedAt)}</span>
        <CaretRightIcon aria-hidden weight="bold" className="size-4 shrink-0 text-ink-3 transition-transform duration-200 group-hover/row:translate-x-0.5" />
      </button>
    </motion.li>
  )
}
