import * as React from "react"
import { useNavigate, useParams } from "react-router-dom"
import { MediaRow } from "@/components/media-row"
import { MediaCard } from "@/components/media-card"
import { Skeleton } from "@/components/ui/skeleton"
import { TitleDialog } from "@/components/title-dialog"
import { fetchDiscoverFeed } from "@/lib/api"
import { useTMDBList, useInfiniteScroll } from "@/lib/hooks"
import type { DiscoverFeed, MediaType, PosterItem } from "@/lib/types"

/**
 * The browse page: the API's pre-built rows, then an endless trending grid.
 *
 * The open title lives in the URL rather than in state, so a title can be
 * linked to directly and the back button closes the dialog.
 */

/** The feed row the API builds as a ranked top ten. */
const RANKED_ROW_ID = "trending-movies"

export function DiscoverPage() {
  const [feed, setFeed] = React.useState<DiscoverFeed | null>(null)
  const [loading, setLoading] = React.useState(true)
  const navigate = useNavigate()
  const params = useParams<{ mediaType?: string; id?: string }>()

  function openItem(item: PosterItem) {
    navigate(`/discover/${item.mediaType}/${item.id}`)
  }

  function closeItem() {
    navigate("/discover")
  }

  React.useEffect(() => {
    fetchDiscoverFeed()
      .then(setFeed)
      .catch(() => {})
      .finally(() => setLoading(false))
  }, [])

  // Seeds the infinite grid below the rows, so its first page is free
  const feedTrendingItems = React.useMemo(
    () => feed?.rows.find((row) => row.id === "trending")?.items ?? [],
    [feed],
  )

  const selectedItem = React.useMemo<PosterItem | null>(() => {
    if (!params.mediaType || !params.id) return null

    const id = Number(params.id)
    if (Number.isNaN(id)) return null

    const mediaType = params.mediaType as MediaType
    if (mediaType !== "movie" && mediaType !== "tv") return null

    // Prefer the feed's copy — it already has the title and artwork
    if (feed) {
      for (const row of feed.rows) {
        const found = row.items.find(
          (item) => item.id === id && item.mediaType === mediaType,
        )
        if (found) return found
      }
    }

    // Otherwise the dialog fills in the rest from TMDB itself
    return { id, mediaType, title: "", posterPath: null, voteAverage: 0 }
  }, [params.mediaType, params.id, feed])

  if (loading) return <DiscoverSkeleton />

  return (
    <div className="space-y-8 py-6">
      {feed?.rows.map((row) => (
        <MediaRow
          key={row.id}
          title={row.title}
          items={row.items}
          ranked={row.id === RANKED_ROW_ID}
          onItemClick={openItem}
        />
      ))}

      {feed && <TrendingGrid initialItems={feedTrendingItems} onItemClick={openItem} />}

      {selectedItem && (
        <TitleDialog item={selectedItem} onClose={closeItem} onItemClick={openItem} />
      )}
    </div>
  )
}

interface TrendingGridProps {
  initialItems: PosterItem[]
  onItemClick: (item: PosterItem) => void
}

function TrendingGrid({ initialItems, onItemClick }: TrendingGridProps) {
  const { items, loadingMore, hasMore, loadMore } = useTMDBList(
    "trending",
    "all",
    initialItems,
  )
  const sentinelRef = useInfiniteScroll(loadMore, hasMore, loadingMore)

  if (items.length === 0) return null

  return (
    <div className="px-4 lg:px-6">
      <h2 className="mb-4 text-xl font-semibold">More Trending</h2>

      <div className="grid grid-cols-3 gap-3 sm:grid-cols-4 md:grid-cols-5 lg:grid-cols-6">
        {items.map((item) => (
          <MediaCard
            key={`${item.mediaType}-${item.id}`}
            title={item.title}
            year={item.year}
            posterPath={item.posterPath}
            mediaType={item.mediaType}
            rating={item.voteAverage}
            onClick={() => onItemClick(item)}
            compact
          />
        ))}
      </div>

      {loadingMore && (
        <div className="mt-3 grid grid-cols-3 gap-3 sm:grid-cols-4 md:grid-cols-5 lg:grid-cols-6">
          {Array.from({ length: 8 }).map((_, i) => (
            <Skeleton key={i} className="aspect-[2/3] w-full rounded-xl" />
          ))}
        </div>
      )}

      <div ref={sentinelRef} className="h-8" />
    </div>
  )
}

function DiscoverSkeleton() {
  return (
    <div className="space-y-8 py-6">
      {Array.from({ length: 5 }).map((_, i) => (
        <div key={i} className="px-4 lg:px-6">
          <Skeleton className="mb-3 h-6 w-48" />
          <div className="flex gap-3">
            {Array.from({ length: 7 }).map((_, j) => (
              <Skeleton
                key={j}
                className="aspect-[2/3] w-36 flex-shrink-0 rounded-xl sm:w-40 md:w-44 lg:w-48"
              />
            ))}
          </div>
        </div>
      ))}
    </div>
  )
}
