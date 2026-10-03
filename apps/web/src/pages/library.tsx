import * as React from "react"
import { useNavigate } from "react-router-dom"
import { AnimatePresence, motion } from "motion/react"
import { useWindowVirtualizer } from "@tanstack/react-virtual"
import {
  ArrowRightIcon,
  BooksIcon,
  CheckIcon,
  CompassIcon,
  FunnelSimpleIcon,
  RowsIcon,
  SortAscendingIcon,
  SquaresFourIcon,
} from "@phosphor-icons/react"
import { DOWNLOAD_STATUS, isActive } from "@/lib/download-status"
import { formatPercent, formatRelativeTime, plural } from "@/lib/format"
import { useLibrary, type LibraryEntry } from "@/lib/library"
import { EASE_OUT, FADE, staggerDelay } from "@/lib/motion"
import { useElementWidth, useIsPhone } from "@/lib/responsive"
import { matchesAll, normalize, queryWords } from "@/lib/search"
import { posterLayoutId, rememberPosterOrigin, useTitleRoute } from "@/lib/title-route"
import { useUpdates } from "@/lib/updates"
import type { MediaType } from "@/lib/types"
import { cn } from "@/lib/utils"
import { PosterCard } from "@/components/media/poster-card"
import { Button } from "@/components/ui/button"
import { Chip } from "@/components/ui/chip"
import { EmptyState } from "@/components/ui/empty-state"
import { Highlight } from "@/components/ui/highlight"
import { Menu, MenuItem } from "@/components/ui/menu"
import { PageHeader } from "@/components/ui/page-header"
import { Poster } from "@/components/ui/poster"
import { ProgressBar } from "@/components/ui/progress-bar"
import { ScrollRow } from "@/components/ui/scroll-row"
import { SearchField } from "@/components/ui/search-field"
import { Segmented } from "@/components/ui/segmented"
import { Skeleton } from "@/components/ui/skeleton"
import { StatusLabel } from "@/components/ui/status-label"
import { UpdateBanner } from "@/components/updates/update-banner"

/**
 * Everything Findr has fetched or tried to fetch. The whole library is held
 * in memory, so search, filters and sorting answer as you type; the grid is
 * virtualised, so thousands of titles scroll as smoothly as twenty.
 */

type TypeFilter = "all" | MediaType
type StatusFilter = "all" | "ready" | "active" | "attention"
type SortKey = "recent" | "title" | "year" | "rating"
type View = "grid" | "list"

const STATUS_FILTERS: { value: StatusFilter; label: string }[] = [
  { value: "all", label: "Any status" },
  { value: "ready", label: "Ready" },
  { value: "active", label: "In progress" },
  { value: "attention", label: "Needs attention" },
]

const SORTS: { value: SortKey; label: string }[] = [
  { value: "recent", label: "Recent activity" },
  { value: "title", label: "Title, A to Z" },
  { value: "year", label: "Newest release" },
  { value: "rating", label: "Highest rated" },
]

/** Per-viewer conveniences remembered between visits. */
const PREFS_KEY = "findr:library-prefs"

/** Smallest card width per breakpoint; columns are as many as fit. */
const MIN_CARD = { phone: 104, wide: 156 }
const GAP = { phone: 12, wide: 20 }
/** Caption block under each poster: title, meta and status lines. */
const CAPTION_HEIGHT = 74
const LIST_ROW_HEIGHT = 76

/** The grouping letter for the A to Z rail; digits and symbols share `#`. */
function letterOf(title: string): string {
  const first = normalize(title.replace(/^(the|a|an)\s+/i, "")).charAt(0).toUpperCase()
  return /[A-Z]/.test(first) ? first : "#"
}

/** Which status group an entry falls in, by its latest download. */
function statusGroup(entry: LibraryEntry): Exclude<StatusFilter, "all"> | null {
  const downloads = entry.title.downloads
  if (downloads.some((download) => isActive(download.status))) return "active"
  const latest = entry.latest?.status
  if (latest === "completed") return "ready"
  if (latest === "failed" || latest === "partial") return "attention"
  return null
}

interface Prefs {
  sort: SortKey
  view: View
}

function loadPrefs(): Prefs {
  try {
    const stored = JSON.parse(localStorage.getItem(PREFS_KEY) ?? "{}") as Partial<Prefs>
    return { sort: stored.sort ?? "recent", view: stored.view ?? "grid" }
  } catch {
    return { sort: "recent", view: "grid" }
  }
}

export function LibraryPage() {
  const { entries, loading, error, active, refresh } = useLibrary()
  const { openTitle } = useTitleRoute()
  const navigate = useNavigate()
  const updates = useUpdates()

  const [query, setQuery] = React.useState("")
  const [type, setType] = React.useState<TypeFilter>("all")
  const [status, setStatus] = React.useState<StatusFilter>("all")
  const [genre, setGenre] = React.useState<string | null>(null)
  const [prefs, setPrefs] = React.useState<Prefs>(loadPrefs)

  function updatePrefs(next: Partial<Prefs>) {
    setPrefs((current) => {
      const merged = { ...current, ...next }
      try {
        localStorage.setItem(PREFS_KEY, JSON.stringify(merged))
      } catch {
        // Remembering is a convenience only
      }
      return merged
    })
  }

  // Typing stays responsive; filtering a large library follows a beat behind
  const deferredQuery = React.useDeferredValue(query)
  const words = React.useMemo(() => queryWords(deferredQuery), [deferredQuery])

  // Each facet counts what it would show with the other filters applied
  const { results, typeCounts, statusCounts, genreCounts, unresolved } = React.useMemo(() => {
    const searched = entries.filter((entry) => words.length === 0 || (entry.card ? matchesAll(entry.card.title, words) : false))
    const byType = (entry: LibraryEntry) => type === "all" || entry.title.mediaType === type
    const byStatus = (entry: LibraryEntry) => status === "all" || statusGroup(entry) === status
    const byGenre = (entry: LibraryEntry) => genre === null || (entry.card?.genres.includes(genre) ?? false)

    const typeCounts = { all: 0, movie: 0, tv: 0 }
    const statusCounts = { all: 0, ready: 0, active: 0, attention: 0 }
    const genreCounts = new Map<string, number>()

    for (const entry of searched) {
      if (byStatus(entry) && byGenre(entry)) {
        typeCounts.all++
        typeCounts[entry.title.mediaType]++
      }
      if (byType(entry) && byGenre(entry)) {
        statusCounts.all++
        const group = statusGroup(entry)
        if (group) statusCounts[group]++
      }
      if (byType(entry) && byStatus(entry)) {
        for (const name of entry.card?.genres ?? []) genreCounts.set(name, (genreCounts.get(name) ?? 0) + 1)
      }
    }

    const filtered = searched.filter((entry) => byType(entry) && byStatus(entry) && byGenre(entry))
    const unresolved = words.length > 0 ? entries.filter((entry) => !entry.card).length : 0

    return { results: sortEntries(filtered, prefs.sort), typeCounts, statusCounts, genreCounts, unresolved }
  }, [entries, words, type, status, genre, prefs.sort])

  const genres = React.useMemo(() => [...genreCounts.entries()].sort((a, b) => b[1] - a[1]), [genreCounts])
  const filtering = words.length > 0 || type !== "all" || status !== "all" || genre !== null

  function clearFilters() {
    setQuery("")
    setType("all")
    setStatus("all")
    setGenre(null)
  }

  const open = React.useCallback(
    (entry: LibraryEntry, layoutId?: string) => {
      if (layoutId) rememberPosterOrigin(layoutId)
      openTitle({ mediaType: entry.title.mediaType, id: entry.title.tmdbId })
    },
    [openTitle],
  )

  // A signature of everything that changes the result set, to replay the reveal
  const signature = `${words.join(" ")}|${type}|${status}|${genre}|${prefs.sort}|${prefs.view}`

  return (
    <div className="mx-auto max-w-[1600px] px-4 md:px-8">
      <PageHeader title="Library" count={loading ? undefined : entries.length}>
        <Segmented
          label="Layout"
          value={prefs.view}
          onChange={(view) => updatePrefs({ view })}
          options={[
            { value: "grid", label: "Posters", icon: SquaresFourIcon },
            { value: "list", label: "List", icon: RowsIcon },
          ]}
        />
      </PageHeader>

      <UpdateBanner updates={updates} dismissible className="mt-5" />
      <ActivityRibbon count={active.length} progress={active[0]?.activeAttempt?.progress} onOpen={() => navigate("/downloads")} />

      {/* Sticky toolbar: search, facets, sort */}
      <div className="bleed-band z-[2] mt-6 pb-3 pt-3 md:sticky md:top-[var(--chrome-height)]">
        <div className="flex flex-col gap-3 lg:flex-row lg:items-center">
          <SearchField
            value={query}
            onChange={setQuery}
            label="Search your library"
            placeholder={`Search ${plural(entries.length, "title")}`}
            shortcut="/"
            data-page-search
            className="lg:w-80"
          />
          <div className="flex items-center gap-2">
            <Segmented
              label="Kind"
              size="sm"
              value={type}
              onChange={setType}
              options={[
                { value: "all", label: "All", count: typeCounts.all },
                { value: "movie", label: "Films", count: typeCounts.movie },
                { value: "tv", label: "Series", count: typeCounts.tv },
              ]}
            />
            <div className="ml-auto lg:ml-0">
              <Menu
                trigger={
                  <Button variant="ghost" size="sm" icon={SortAscendingIcon}>
                    <span className="hidden sm:inline">{SORTS.find((sort) => sort.value === prefs.sort)?.label}</span>
                    <span className="sm:hidden">Sort</span>
                  </Button>
                }
              >
                {SORTS.map((sort) => (
                  <MenuItem key={sort.value} onClick={() => updatePrefs({ sort: sort.value })}>
                    <span className={cn("flex-1", sort.value === prefs.sort && "font-semibold")}>{sort.label}</span>
                    {sort.value === prefs.sort && <CheckIcon aria-hidden weight="bold" className="size-4 text-signal-ink" />}
                  </MenuItem>
                ))}
              </Menu>
            </div>
          </div>
        </div>

        <ScrollRow label="Filters" className="mt-3" trackClassName="-mx-4 gap-2 px-4 md:-mx-8 md:px-8">
          {STATUS_FILTERS.map((filter) => (
            <Chip
              key={filter.value}
              selected={status === filter.value}
              count={statusCounts[filter.value]}
              onClick={() => setStatus(filter.value)}
            >
              {filter.label}
            </Chip>
          ))}
          {genres.length > 0 && <span aria-hidden className="mx-1 h-6 w-px shrink-0 self-center bg-line-strong" />}
          {genres.map(([name, count]) => (
            <Chip key={name} selected={genre === name} count={count} onClick={() => setGenre(genre === name ? null : name)}>
              {name}
            </Chip>
          ))}
        </ScrollRow>
      </div>

      <div className="mt-4 flex min-h-6 items-center justify-between gap-4 text-[0.8125rem] text-ink-2" aria-live="polite">
        {!loading && (
          <span>
            {filtering ? `${plural(results.length, "match", "matches")}` : plural(results.length, "title")}
            {unresolved > 0 && <span className="text-ink-3">, still reading {plural(unresolved, "title")} from TMDB</span>}
          </span>
        )}
        {filtering && (
          <button type="button" onClick={clearFilters} className="rounded-full px-2 py-1 font-medium text-ink underline decoration-signal decoration-2 underline-offset-4 hover:decoration-ink">
            Clear filters
          </button>
        )}
      </div>

      {loading ? (
        <GridSkeleton />
      ) : error && entries.length === 0 ? (
        <EmptyState icon={BooksIcon} title="The library did not load" description={error} action={<Button variant="ink" onClick={refresh}>Try again</Button>} />
      ) : entries.length === 0 ? (
        <EmptyState
          icon={BooksIcon}
          title="Nothing here yet"
          description="Titles appear here once you download them. Find something to start with on Discover."
          action={
            <Button variant="signal" icon={CompassIcon} onClick={() => navigate("/discover")}>
              Browse Discover
            </Button>
          }
        />
      ) : results.length === 0 ? (
        <EmptyState
          icon={FunnelSimpleIcon}
          title="No titles match"
          description={query ? <>Nothing in your library matches <span className="font-semibold text-ink">“{query.trim()}”</span> with these filters.</> : "Nothing in your library matches these filters."}
          action={<Button variant="ink" onClick={clearFilters}>Clear filters</Button>}
        />
      ) : (
        <Results entries={results} view={prefs.view} words={words} sort={prefs.sort} signature={signature} onOpen={open} />
      )}
    </div>
  )
}

/** Orders entries; the API already returns them by recent activity. */
function sortEntries(entries: LibraryEntry[], sort: SortKey): LibraryEntry[] {
  if (sort === "recent") return entries
  const sorted = [...entries]
  if (sort === "title") sorted.sort((a, b) => (a.card?.title ?? "￿").localeCompare(b.card?.title ?? "￿", undefined, { sensitivity: "base", ignorePunctuation: true }))
  if (sort === "year") sorted.sort((a, b) => (b.card?.year ?? "").localeCompare(a.card?.year ?? ""))
  if (sort === "rating") sorted.sort((a, b) => (b.card?.voteAverage ?? 0) - (a.card?.voteAverage ?? 0))
  return sorted
}

/* -------------------------------------------------------------------------- */
/* Scoped components                                                          */
/* -------------------------------------------------------------------------- */

interface ResultsProps {
  entries: LibraryEntry[]
  view: View
  words: string[]
  sort: SortKey
  signature: string
  onOpen: (entry: LibraryEntry, layoutId?: string) => void
}

/**
 * The virtualised result set. Rows are laid out from the measured width, so
 * every row's height is known up front and nothing jumps while scrolling.
 * When the filters change, the cards in view replay a short staggered entry.
 */
function Results({ entries, view, words, sort, signature, onOpen }: ResultsProps) {
  const phone = useIsPhone()
  const [measureRef, width] = useElementWidth<HTMLDivElement>()
  const containerRef = React.useRef<HTMLDivElement | null>(null)
  const [offset, setOffset] = React.useState(0)

  const gap = phone ? GAP.phone : GAP.wide
  const minCard = phone ? MIN_CARD.phone : MIN_CARD.wide
  const columns = view === "list" ? 1 : Math.max(3, Math.floor((width + gap) / (minCard + gap)))
  const cardWidth = view === "list" ? width : (width - gap * (columns - 1)) / columns
  const rowHeight = view === "list" ? LIST_ROW_HEIGHT : cardWidth * 1.5 + CAPTION_HEIGHT + gap
  const rowCount = Math.ceil(entries.length / columns)

  // The list starts below the header and toolbar; the virtualiser needs to know where
  React.useLayoutEffect(() => {
    if (containerRef.current) setOffset(containerRef.current.getBoundingClientRect().top + window.scrollY)
  }, [width, view])

  const virtualizer = useWindowVirtualizer({
    count: width > 0 ? rowCount : 0,
    estimateSize: () => rowHeight,
    overscan: 4,
    scrollMargin: offset,
  })

  React.useEffect(() => virtualizer.measure(), [rowHeight, virtualizer])

  // Replay the entry animation only for a moment after the filters change
  const revealUntil = React.useRef(0)
  const [generation, setGeneration] = React.useState(0)
  React.useEffect(() => {
    revealUntil.current = performance.now() + 450
    setGeneration((current) => current + 1)
  }, [signature])
  const revealing = performance.now() < revealUntil.current

  // Letters present in a title sort, mapped to their first row
  const letters = React.useMemo(() => {
    if (sort !== "title") return null
    const first = new Map<string, number>()
    entries.forEach((entry, index) => {
      const letter = letterOf(entry.card?.title ?? "")
      if (!first.has(letter)) first.set(letter, Math.floor(index / columns))
    })
    return first
  }, [entries, sort, columns])

  const rows = virtualizer.getVirtualItems()
  const firstRow = rows[0]?.index ?? 0

  return (
    <div className="relative">
      <div
        ref={(node) => {
          containerRef.current = node
          measureRef(node)
        }}
        className={cn("relative mt-4", letters && "lg:mr-10")}
        style={{ height: virtualizer.getTotalSize() }}
      >
        {rows.map((row) => {
          const start = row.index * columns
          const slice = entries.slice(start, start + columns)
          return (
            <div
              key={row.key}
              className="absolute inset-x-0 top-0"
              style={{ transform: `translateY(${row.start - virtualizer.options.scrollMargin}px)`, height: rowHeight }}
            >
              {view === "grid" ? (
                <div className="grid" style={{ gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))`, columnGap: gap }}>
                  {slice.map((entry, column) => {
                    const order = (row.index - firstRow) * columns + column
                    return (
                      <Reveal key={`${generation}:${entry.key}`} animate={revealing} order={order}>
                        <GridCard entry={entry} words={words} onOpen={onOpen} />
                      </Reveal>
                    )
                  })}
                </div>
              ) : (
                slice.map((entry) => (
                  <Reveal key={`${generation}:${entry.key}`} animate={revealing} order={row.index - firstRow}>
                    <ListRow entry={entry} words={words} onOpen={onOpen} />
                  </Reveal>
                ))
              )}
            </div>
          )
        })}
      </div>

      {letters && <LetterRail letters={letters} onJump={(rowIndex) => virtualizer.scrollToIndex(rowIndex, { align: "start" })} />}
    </div>
  )
}

interface RevealProps {
  animate: boolean
  order: number
  children: React.ReactNode
}

/** Fades a card in, staggered by its position, when the results have just changed. */
function Reveal({ animate, order, children }: RevealProps) {
  return (
    <motion.div
      initial={animate ? { opacity: 0, y: 14 } : false}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.4, ease: EASE_OUT, delay: animate ? staggerDelay(order) : 0 }}
    >
      {children}
    </motion.div>
  )
}

interface CardProps {
  entry: LibraryEntry
  words: string[]
  onOpen: (entry: LibraryEntry, layoutId?: string) => void
}

/** What a library card says about status: nothing when the title is simply ready. */
function cardStatus(entry: LibraryEntry) {
  const running = entry.title.downloads.find((download) => isActive(download.status))
  if (running) return { status: DOWNLOAD_STATUS[running.status], progress: running.activeAttempt?.progress ?? null }
  if (entry.latest && entry.latest.status !== "completed") return { status: DOWNLOAD_STATUS[entry.latest.status], progress: undefined }
  return { status: undefined, progress: undefined }
}

function GridCard({ entry, words, onOpen }: CardProps) {
  const layoutId = posterLayoutId("library", entry.key)
  const { status, progress } = cardStatus(entry)

  if (!entry.card) {
    return (
      <div>
        <Skeleton className="aspect-[2/3] w-full" />
        <Skeleton className="mt-3 h-3.5 w-3/4 rounded-full" />
        <Skeleton className="mt-2 h-2.5 w-1/3 rounded-full" />
      </div>
    )
  }

  return (
    <PosterCard
      title={entry.card.title}
      year={entry.card.year}
      mediaType={entry.title.mediaType}
      posterPath={entry.card.posterPath}
      layoutId={layoutId}
      status={status}
      progress={progress}
      highlight={words}
      onOpen={() => onOpen(entry, layoutId)}
    />
  )
}

/** Downloaded seasons of a show, as a compact range like "S1-3, S5". */
function seasonsSummary(entry: LibraryEntry): string | null {
  const seasons = [...new Set(entry.title.downloads.filter((download) => download.status === "completed" || download.status === "partial").map((download) => download.season ?? 0))].sort((a, b) => a - b)
  if (seasons.length === 0) return null

  const runs: string[] = []
  let start = seasons[0] as number
  let previous = start
  for (const season of [...seasons.slice(1), Infinity]) {
    if (season === previous + 1) {
      previous = season
      continue
    }
    runs.push(start === previous ? `S${start}` : `S${start}-${previous}`)
    start = season
    previous = season
  }
  return runs.join(", ")
}

function ListRow({ entry, words, onOpen }: CardProps) {
  const { status, progress } = cardStatus(entry)
  const card = entry.card
  const seasons = entry.title.mediaType === "tv" ? seasonsSummary(entry) : null

  return (
    <button
      type="button"
      onClick={() => onOpen(entry)}
      className="group/row flex h-[68px] w-full items-center gap-4 rounded-[0.875rem] px-2 text-left transition-colors duration-150 hover:bg-surface hover:shadow-ring focus-visible:bg-surface"
    >
      <Poster path={card?.posterPath} title={card?.title ?? ""} size="thumb" className="w-10 shrink-0 rounded-[0.375rem]" />
      <div className="min-w-0 flex-1">
        <p className="truncate text-[0.9375rem] font-semibold text-ink">
          {card ? <Highlight text={card.title} words={words} /> : <span className="text-ink-3">Loading</span>}
        </p>
        <p className="truncate text-micro text-ink-3">
          <span className="font-mono tabular">{card?.year || "No date"}</span> · {entry.title.mediaType === "tv" ? "Series" : "Film"}
          {seasons && <span className="font-mono"> {seasons}</span>}
        </p>
      </div>
      <p className="hidden w-48 truncate text-[0.8125rem] text-ink-2 lg:block">{card?.genres.slice(0, 2).join(", ")}</p>
      <div className="hidden w-40 sm:block">
        {status && <StatusLabel status={status} />}
        {progress !== undefined && <ProgressBar value={progress ?? undefined} label="Progress" size="hair" className="mt-1.5" />}
      </div>
      <span className="hidden w-20 text-right font-mono text-micro text-ink-3 tabular md:block">
        {entry.latest ? formatRelativeTime(entry.latest.updatedAt) : ""}
      </span>
      <ArrowRightIcon aria-hidden weight="bold" className="size-4 shrink-0 text-ink-3 opacity-0 transition-[opacity,transform] duration-200 group-hover/row:translate-x-0.5 group-hover/row:opacity-100" />
    </button>
  )
}

interface LetterRailProps {
  letters: Map<string, number>
  onJump: (rowIndex: number) => void
}

const ALPHABET = ["#", ..."ABCDEFGHIJKLMNOPQRSTUVWXYZ"]

/** A to Z down the right edge while sorted by title; absent letters are dimmed. */
function LetterRail({ letters, onJump }: LetterRailProps) {
  return (
    <nav aria-label="Jump to letter" className="absolute inset-y-0 right-0 hidden w-8 lg:block">
      <div className="sticky top-[calc(var(--chrome-height)+9rem)] flex flex-col items-center">
        {ALPHABET.map((letter) => {
          const row = letters.get(letter)
          return (
            <button
              key={letter}
              type="button"
              disabled={row === undefined}
              onClick={() => row !== undefined && onJump(row)}
              className="flex h-[1.15rem] w-7 items-center justify-center rounded-full font-mono text-micro font-semibold text-ink-2 transition-[transform,background-color,color] duration-150 hover:scale-125 hover:bg-signal hover:text-ink disabled:text-line-strong disabled:hover:scale-100 disabled:hover:bg-transparent"
            >
              {letter}
            </button>
          )
        })}
      </div>
    </nav>
  )
}

interface ActivityRibbonProps {
  count: number
  progress: number | undefined
  onOpen: () => void
}

/** A slim link to Downloads while anything is running. */
function ActivityRibbon({ count, progress, onOpen }: ActivityRibbonProps) {
  return (
    <AnimatePresence initial={false}>
      {count > 0 && (
        <motion.button
          type="button"
          onClick={onOpen}
          initial={{ opacity: 0, height: 0 }}
          animate={{ opacity: 1, height: "auto" }}
          exit={{ opacity: 0, height: 0 }}
          transition={FADE}
          className="group/ribbon mt-5 block w-full overflow-hidden text-left"
        >
          <span className="flex items-center gap-4 rounded-full bg-surface py-2 pl-4 pr-2 shadow-ring transition-shadow hover:shadow-lift">
            <span className="text-sm font-semibold text-ink">{plural(count, "download")} in progress</span>
            <ProgressBar value={progress} label="Current download progress" size="sm" className="hidden max-w-60 flex-1 sm:block" />
            {progress !== undefined && <span className="hidden font-mono text-micro text-ink-2 tabular sm:inline">{formatPercent(progress)}</span>}
            <span className="ml-auto inline-flex h-8 items-center gap-1.5 rounded-full bg-sunken px-3 text-[0.8125rem] font-medium text-ink transition-colors group-hover/ribbon:bg-signal">
              Downloads
              <ArrowRightIcon aria-hidden weight="bold" className="size-3.5 transition-transform group-hover/ribbon:translate-x-0.5" />
            </span>
          </span>
        </motion.button>
      )}
    </AnimatePresence>
  )
}

function GridSkeleton() {
  return (
    <div className="mt-4 grid grid-cols-3 gap-3 sm:grid-cols-4 md:gap-5 lg:grid-cols-6 xl:grid-cols-8">
      {Array.from({ length: 16 }, (_, index) => (
        <div key={index}>
          <Skeleton className="aspect-[2/3] w-full" />
          <Skeleton className="mt-3 h-3.5 w-3/4 rounded-full" />
          <Skeleton className="mt-2 h-2.5 w-1/3 rounded-full" />
        </div>
      ))}
    </div>
  )
}
