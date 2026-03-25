import { useState, useEffect, useRef, useCallback } from "react"
import { Navigate } from "react-router-dom"
import { Loader2 } from "lucide-react"
import { auth } from "@/lib/auth"
import { MediaCard } from "@/components/media-card"
import { MediaDetailDialog } from "@/components/media-detail-dialog"
import {
  useTMDBDiscover,
  type DiscoverTab,
  type TMDBDiscoverItem,
} from "@/hooks/use-tmdb-trending"

type MediaFilter = "all" | "movie" | "tv"

function FilterPill({
  label,
  active,
  onClick,
}: {
  label: string
  active: boolean
  onClick: () => void
}) {
  return (
    <button
      onClick={onClick}
      className={
        active
          ? "px-4 py-2 rounded-full bg-findr-text text-white text-xs font-bold uppercase tracking-wide shadow-sm hover:opacity-90 transition-opacity"
          : "px-4 py-2 rounded-full bg-white border border-findr-border text-findr-secondary text-xs font-bold uppercase tracking-wide hover:border-findr-tertiary hover:text-findr-text transition-all"
      }
    >
      {label}
    </button>
  )
}

function useInfiniteScroll(
  loadMore: () => void,
  hasMore: boolean,
  isLoading: boolean,
) {
  const nodeRef = useRef<HTMLDivElement | null>(null)
  const observerRef = useRef<IntersectionObserver | null>(null)
  const callbackRef = useRef(loadMore)
  callbackRef.current = loadMore
  const hasMoreRef = useRef(hasMore)
  hasMoreRef.current = hasMore
  const isLoadingRef = useRef(isLoading)
  isLoadingRef.current = isLoading

  const attachObserver = useCallback((node: HTMLDivElement | null) => {
    // Clean up previous
    if (observerRef.current) {
      observerRef.current.disconnect()
      observerRef.current = null
    }
    nodeRef.current = node
    if (!node) return

    observerRef.current = new IntersectionObserver(
      (entries) => {
        if (
          entries[0]?.isIntersecting &&
          hasMoreRef.current &&
          !isLoadingRef.current
        ) {
          callbackRef.current()
        }
      },
      { rootMargin: "200px" },
    )
    observerRef.current.observe(node)
  }, [])

  // When loading finishes, re-attach the observer so it re-evaluates
  // whether the sentinel is intersecting (it fires on observe).
  useEffect(() => {
    if (!isLoading && hasMore && nodeRef.current) {
      attachObserver(nodeRef.current)
    }
  }, [isLoading, hasMore, attachObserver])

  return attachObserver
}

export default function Discover() {
  const { data: session, isPending } = auth.useSession()
  const [activeTab, setActiveTab] = useState<DiscoverTab>("trending")
  const [mediaFilter, setMediaFilter] = useState<MediaFilter>("all")
  const { items, loading, loadingMore, hasMore, loadMore } =
    useTMDBDiscover(activeTab)
  const [selectedItem, setSelectedItem] = useState<TMDBDiscoverItem | null>(
    null
  )
  const [dialogOpen, setDialogOpen] = useState(false)

  const sentinelRef = useInfiniteScroll(loadMore, hasMore, loadingMore)

  if (isPending) return null
  if (!session) return <Navigate to="/login" replace />

  const filtered =
    mediaFilter === "all"
      ? items
      : items.filter((item) => item.mediaType === mediaFilter)

  function openDetail(item: TMDBDiscoverItem) {
    setSelectedItem(item)
    setDialogOpen(true)
  }

  return (
    <div className="max-w-[1600px] mx-auto">
      {/* Page Header & Filters */}
      <div className="sticky top-16 bg-findr-bg/95 backdrop-blur-md z-40 border-b border-findr-border">
        <div className="px-6 py-6 md:py-8">
          <div className="flex flex-col md:flex-row md:items-end justify-between gap-6">
            <div>
              <h1 className="text-3xl font-extrabold tracking-tight text-findr-text mb-2">
                Popular Discover
              </h1>
              <p className="text-findr-secondary text-sm font-medium">
                Explore trending movies and TV shows to add to your library.
              </p>
            </div>

            <div className="flex flex-wrap items-center gap-2">
              <FilterPill
                label="Trending Now"
                active={activeTab === "trending"}
                onClick={() => setActiveTab("trending")}
              />
              <FilterPill
                label="Top Rated"
                active={activeTab === "top_rated"}
                onClick={() => setActiveTab("top_rated")}
              />

              <div className="w-px h-6 bg-findr-border mx-2 hidden sm:block" />

              <select
                value={mediaFilter}
                onChange={(e) =>
                  setMediaFilter(e.target.value as MediaFilter)
                }
                className="h-9 px-4 bg-white border border-findr-border rounded-full text-xs font-bold uppercase tracking-wide text-findr-text focus:outline-none focus:border-findr-amber cursor-pointer hover:border-findr-tertiary transition-all appearance-none pr-8 bg-no-repeat"
                style={{
                  backgroundImage: `url('data:image/svg+xml;utf8,<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="%23666666" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m6 9 6 6 6-6"/></svg>')`,
                  backgroundPosition: "right 10px center",
                  backgroundSize: "16px",
                }}
              >
                <option value="all">All Types</option>
                <option value="movie">Movies</option>
                <option value="tv">Series</option>
              </select>
            </div>
          </div>
        </div>
      </div>

      {/* Grid Content */}
      <div className="p-6 md:p-8">
        {loading ? (
          <div className="flex items-center justify-center py-24">
            <Loader2 className="size-8 animate-spin text-findr-amber" />
          </div>
        ) : (
          <>
            <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5 gap-5 md:gap-6">
              {filtered.map((item) => (
                <MediaCard
                  key={`${item.mediaType}-${item.id}`}
                  title={item.title}
                  year={item.year}
                  rating={item.rating}
                  posterUrl={item.posterPath}
                  mediaType={item.mediaType}
                  onClick={() => openDetail(item)}
                />
              ))}
            </div>

            {/* Infinite scroll sentinel */}
            <div ref={sentinelRef} className="w-full py-8 flex justify-center">
              {loadingMore && (
                <Loader2 className="size-6 animate-spin text-findr-amber" />
              )}
            </div>
          </>
        )}
      </div>

      <MediaDetailDialog
        item={selectedItem}
        open={dialogOpen}
        onOpenChange={setDialogOpen}
      />
    </div>
  )
}
