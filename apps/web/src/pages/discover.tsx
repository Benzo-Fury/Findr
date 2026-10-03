import * as React from "react"
import { useSearchParams } from "react-router-dom"
import { AnimatePresence, motion } from "motion/react"
import { ArrowLeftIcon, CompassIcon, SparkleIcon } from "@phosphor-icons/react"
import { browseTMDB, fetchDiscoverFeed, fetchGenres, fetchList, type ListSource } from "@/lib/api"
import { usePagedPosters } from "@/lib/hooks"
import { EASE_OUT, SPRING_SNAP } from "@/lib/motion"
import type { BrowseSort, DiscoverFeed, DiscoverRow, Genre, MediaType } from "@/lib/types"
import { cn } from "@/lib/utils"
import { LandscapeShelf } from "@/components/discover/landscape-shelf"
import { Mosaic } from "@/components/discover/mosaic"
import { PosterShelf } from "@/components/discover/poster-shelf"
import { RankedShelf } from "@/components/discover/ranked-shelf"
import { Shelf } from "@/components/discover/shelf"
import { Spotlight } from "@/components/discover/spotlight"
import { PosterGrid, PosterGridSkeleton } from "@/components/media/poster-grid"
import { Button } from "@/components/ui/button"
import { EmptyState } from "@/components/ui/empty-state"
import { PageHeader } from "@/components/ui/page-header"
import { Segmented } from "@/components/ui/segmented"
import { Skeleton } from "@/components/ui/skeleton"

/**
 * Browsing TMDB. "Highlights" composes the curated feed into shelves of
 * different shapes; every genre is a category of its own with an endless
 * grid; and any shelf opens into its full list. The category, kind and
 * order live in the URL, so a view can be linked to and Back retraces it.
 */

type TypeFilter = "all" | MediaType

/** A category, as written in the URL's `c` parameter. */
type Category = { kind: "highlights" } | { kind: "genre"; name: string } | { kind: "list"; source: ListSource; mediaType?: MediaType; title: string }

const SORTS: { value: BrowseSort; label: string }[] = [
  { value: "popular", label: "Popular" },
  { value: "rated", label: "Top rated" },
  { value: "recent", label: "Newest" },
]

/** How each feed row is composed, by row id. Rows not listed are poster shelves. */
const SHELF_LAYOUT: Record<string, "spotlight" | "ranked" | "landscape" | "mosaic"> = {
  trending: "spotlight",
  "trending-movies": "ranked",
  "popular-tv": "landscape",
  acclaimed: "mosaic",
}

/** The list source and kind behind a feed row id such as `popular-tv`. */
function sourceOf(row: DiscoverRow): { source: ListSource; mediaType?: MediaType } {
  const match = row.id.match(/^(.*)-(movie|tv)$/)
  return match ? { source: match[1] as ListSource, mediaType: match[2] as MediaType } : { source: row.id as ListSource }
}

function parseCategory(value: string | null, feed: DiscoverFeed | null): Category {
  if (value?.startsWith("g:")) return { kind: "genre", name: value.slice(2) }
  if (value?.startsWith("l:")) {
    const row = feed?.rows.find((candidate) => candidate.id === value.slice(2))
    if (row) return { kind: "list", ...sourceOf(row), title: row.title }
  }
  return { kind: "highlights" }
}

export function DiscoverPage() {
  const [params, setParams] = useSearchParams()
  const [feed, setFeed] = React.useState<DiscoverFeed | null>(null)
  const [genres, setGenres] = React.useState<Genre[]>([])
  const [feedError, setFeedError] = React.useState(false)

  const type = (["movie", "tv"].includes(params.get("type") ?? "") ? params.get("type") : "all") as TypeFilter
  const sort = (SORTS.some((option) => option.value === params.get("sort")) ? params.get("sort") : "popular") as BrowseSort
  const category = parseCategory(params.get("c"), feed)
  const categoryKey = category.kind === "highlights" ? "highlights" : category.kind === "genre" ? `g:${category.name}` : `l:${params.get("c")?.slice(2)}`

  const loadFeed = React.useCallback(() => {
    setFeedError(false)
    fetchDiscoverFeed()
      .then(setFeed)
      .catch(() => setFeedError(true))
  }, [])

  React.useEffect(() => {
    loadFeed()
    fetchGenres()
      .then(setGenres)
      .catch(() => {})
  }, [loadFeed])

  /** Changes URL parameters, keeping the rest (including an open title). */
  function update(next: Record<string, string | null>) {
    setParams((current) => {
      const merged = new URLSearchParams(current)
      for (const [key, value] of Object.entries(next)) {
        if (value === null) merged.delete(key)
        else merged.set(key, value)
      }
      return merged
    })
    window.scrollTo({ top: 0, behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth" })
  }

  // Genres available for the chosen kind
  const visibleGenres = genres.filter((genre) => type === "all" || genre[type] !== null)

  return (
    <div className="mx-auto max-w-[1600px] px-4 md:px-8">
      <PageHeader title="Discover">
        <Segmented
          label="Kind"
          value={type}
          onChange={(value) => update({ type: value === "all" ? null : value })}
          options={[
            { value: "all", label: "All" },
            { value: "movie", label: "Films" },
            { value: "tv", label: "Series" },
          ]}
        />
      </PageHeader>

      <CategoryBar
        current={categoryKey}
        genres={visibleGenres}
        onSelect={(key) => update({ c: key === "highlights" ? null : key, sort: null })}
      />

      <AnimatePresence mode="wait" initial={false}>
        <motion.div
          key={`${categoryKey}|${type}`}
          initial={{ opacity: 0, y: 18 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, y: -10 }}
          transition={{ duration: 0.32, ease: EASE_OUT }}
        >
          {category.kind === "highlights" &&
            (feedError ? (
              <EmptyState icon={CompassIcon} title="Discover could not load" description="TMDB did not answer. Check the TMDB API key in Settings, or try again." action={<Button variant="ink" onClick={loadFeed}>Try again</Button>} />
            ) : feed ? (
              <Highlights feed={feed} type={type} onSeeAll={(row) => update({ c: `l:${row.id}` })} />
            ) : (
              <HighlightsSkeleton />
            ))}

          {category.kind === "genre" && (
            <GenreView
              genre={genres.find((genre) => genre.name === category.name) ?? null}
              name={category.name}
              type={type}
              sort={sort}
              onSort={(value) => update({ sort: value === "popular" ? null : value })}
            />
          )}

          {category.kind === "list" && <ListView category={category} type={type} onBack={() => update({ c: null })} />}
        </motion.div>
      </AnimatePresence>
    </div>
  )
}

/* -------------------------------------------------------------------------- */
/* Scoped components                                                          */
/* -------------------------------------------------------------------------- */

interface CategoryBarProps {
  current: string
  genres: Genre[]
  onSelect: (key: string) => void
}

/**
 * Highlights and every genre in one sticky rail. The amber marker slides to
 * the chosen category, and the rail scrolls it into view.
 */
function CategoryBar({ current, genres, onSelect }: CategoryBarProps) {
  const railRef = React.useRef<HTMLDivElement>(null)

  React.useEffect(() => {
    const active = railRef.current?.querySelector<HTMLElement>("[aria-current='true']")
    active?.scrollIntoView({ block: "nearest", inline: "center", behavior: "smooth" })
  }, [current])

  const options = [{ key: "highlights", label: "Highlights" }, ...genres.map((genre) => ({ key: `g:${genre.name}`, label: genre.name }))]
  const listOpen = current.startsWith("l:")

  return (
    <nav aria-label="Categories" className="bleed-band sticky top-[var(--chrome-height)] z-[2] mt-6">
      <div ref={railRef} className="scroll-x -mx-4 flex gap-1 px-4 py-2.5 md:-mx-8 md:px-8">
        {options.map((option) => {
          const active = option.key === current || (listOpen && option.key === "highlights")
          return (
            <button
              key={option.key}
              type="button"
              aria-current={active}
              onClick={() => onSelect(option.key)}
              className={cn(
                "relative inline-flex h-9 shrink-0 items-center gap-1.5 rounded-full px-4 text-sm font-semibold transition-colors duration-200 active:scale-[0.97]",
                active ? "text-ink" : "text-ink-2 hover:bg-sunken hover:text-ink",
              )}
            >
              {active && <motion.span layoutId="category-marker" transition={SPRING_SNAP} className="absolute inset-0 rounded-full bg-signal" />}
              {option.key === "highlights" && <SparkleIcon aria-hidden weight="fill" className="relative size-3.5" />}
              <span className="relative">{option.label}</span>
            </button>
          )
        })}
      </div>
    </nav>
  )
}

interface HighlightsProps {
  feed: DiscoverFeed
  type: TypeFilter
  onSeeAll: (row: DiscoverRow) => void
}

/** The curated feed, each row in the shape that suits it. */
function Highlights({ feed, type, onSeeAll }: HighlightsProps) {
  const rows = feed.rows
    .map((row) => ({ ...row, items: type === "all" ? row.items : row.items.filter((item) => item.mediaType === type) }))
    .filter((row) => row.items.length > 0)

  if (rows.length === 0) {
    return <EmptyState icon={CompassIcon} title="Nothing to show" description="The curated lists have no titles of this kind right now. Pick a genre above instead." />
  }

  return (
    <div className="pt-6 md:pt-8">
      {rows.map((row) => {
        const layout = SHELF_LAYOUT[row.id]
        const scope = `discover-${row.id}`

        if (layout === "spotlight") return <Spotlight key={row.id} items={row.items} scope={scope} />

        return (
          <Shelf key={row.id} title={row.title} onSeeAll={() => onSeeAll(row)}>
            {layout === "ranked" ? (
              <RankedShelf label={row.title} scope={scope} items={row.items} />
            ) : layout === "landscape" ? (
              <LandscapeShelf label={row.title} scope={scope} items={row.items} />
            ) : layout === "mosaic" ? (
              <Mosaic scope={scope} items={row.items} />
            ) : (
              <PosterShelf label={row.title} scope={scope} items={row.items} />
            )}
          </Shelf>
        )
      })}
    </div>
  )
}

interface GenreViewProps {
  genre: Genre | null
  name: string
  type: TypeFilter
  sort: BrowseSort
  onSort: (sort: BrowseSort) => void
}

/** One genre, endlessly, in the chosen order. */
function GenreView({ genre, name, type, sort, onSort }: GenreViewProps) {
  const movieGenre = genre?.movie ?? undefined
  const tvGenre = genre?.tv ?? undefined
  const key = `${name}|${type}|${sort}|${movieGenre}|${tvGenre}`

  const { items, loading, loadingMore, hasMore, loadMore, error } = usePagedPosters(key, (page, signal) =>
    browseTMDB({ mediaType: type, movieGenre, tvGenre, sort, page }, { signal }),
  )

  return (
    <div className="pt-8">
      <div className="mb-6 flex flex-col gap-4 md:flex-row md:items-end md:justify-between">
        <h2 className="display text-5xl text-ink md:text-6xl">{name}</h2>
        <Segmented label="Order" value={sort} onChange={onSort} options={SORTS} />
      </div>
      {!genre ? (
        <PosterGridSkeleton />
      ) : error ? (
        <EmptyState icon={CompassIcon} title="This genre could not load" description="TMDB did not answer. Try again in a moment." />
      ) : !loading && items.length === 0 ? (
        <EmptyState icon={CompassIcon} title={`No ${type === "tv" ? "series" : type === "movie" ? "films" : "titles"} here`} description="Try another kind or order." />
      ) : (
        <PosterGrid items={items} scope={`genre-${name}`} loading={loading} loadingMore={loadingMore} hasMore={hasMore} onLoadMore={loadMore} />
      )}
    </div>
  )
}

interface ListViewProps {
  category: Extract<Category, { kind: "list" }>
  type: TypeFilter
  onBack: () => void
}

/** The full list behind one highlights shelf. */
function ListView({ category, type, onBack }: ListViewProps) {
  const mediaType = category.mediaType ?? type
  const key = `${category.source}|${mediaType}`
  const { items, loading, loadingMore, hasMore, loadMore } = usePagedPosters(key, (page) => fetchList(category.source, page, mediaType))
  const shown = type === "all" ? items : items.filter((item) => item.mediaType === type)

  return (
    <div className="pt-8">
      <div className="mb-6 flex flex-col items-start gap-3">
        <Button variant="ghost" size="sm" icon={ArrowLeftIcon} onClick={onBack} className="-ml-3">
          Highlights
        </Button>
        <h2 className="display text-5xl text-ink md:text-6xl">{category.title}</h2>
      </div>
      <PosterGrid items={shown} scope={`list-${category.source}`} loading={loading} loadingMore={loadingMore} hasMore={hasMore} onLoadMore={loadMore} />
    </div>
  )
}

function HighlightsSkeleton() {
  return (
    <div className="pt-6 md:pt-8">
      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_19rem] lg:gap-6">
        <Skeleton className="aspect-[4/5] rounded-panel sm:aspect-[16/10] lg:aspect-auto lg:min-h-[30rem]" />
        <div className="hidden flex-col gap-2 lg:flex">
          {Array.from({ length: 6 }, (_, index) => (
            <Skeleton key={index} className="h-[4.5rem] rounded-[0.875rem]" />
          ))}
        </div>
      </div>
      <Skeleton className="mt-16 h-8 w-56 rounded-full" />
      <div className="mt-5 flex gap-5 overflow-hidden">
        {Array.from({ length: 8 }, (_, index) => (
          <Skeleton key={index} className="aspect-[2/3] w-36 shrink-0 lg:w-44" />
        ))}
      </div>
    </div>
  )
}
