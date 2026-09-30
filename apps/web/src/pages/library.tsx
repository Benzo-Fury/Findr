import * as React from "react"
import { Search } from "lucide-react"
import type { DownloadStatus, TitleSummary } from "@findr/types/downloads"
import { fetchTitles } from "@/lib/api"
import { DOWNLOAD_STATUS } from "@/lib/download-status"
import { tmdbKey, useInfiniteScroll, useTMDBMeta } from "@/lib/hooks"
import type { PosterItem } from "@/lib/types"
import { MediaCard } from "@/components/media-card"
import { StatusBadge } from "@/components/status-badge"
import { TitleDialog } from "@/components/title-dialog"
import { Skeleton } from "@/components/ui/skeleton"

/**
 * Everything that has been requested, one poster per title with the state of
 * its most recent download. Artwork and names are resolved from TMDB, since
 * titles store only their TMDB identity.
 */

const PAGE_SIZE = 50

export function LibraryPage() {
  const [titles, setTitles] = React.useState<TitleSummary[]>([])
  const [total, setTotal] = React.useState(0)
  const [page, setPage] = React.useState(1)
  const [loading, setLoading] = React.useState(true)
  const [loadingMore, setLoadingMore] = React.useState(false)
  const [titleItem, setTitleItem] = React.useState<PosterItem | null>(null)
  const { meta, fetchMeta } = useTMDBMeta()

  // Append each page as it arrives
  React.useEffect(() => {
    fetchTitles(page, PAGE_SIZE)
      .then((result) => {
        setTitles((prev) => (page === 1 ? result.items : [...prev, ...result.items]))
        setTotal(result.total)
      })
      .catch(() => {})
      .finally(() => {
        setLoading(false)
        setLoadingMore(false)
      })
  }, [page])

  const hasMore = titles.length < total
  const loadMore = React.useCallback(() => {
    setLoadingMore(true)
    setPage((current) => current + 1)
  }, [])
  const sentinel = useInfiniteScroll(loadMore, hasMore, loadingMore)

  React.useEffect(() => {
    for (const title of titles) fetchMeta(title.mediaType, title.tmdbId)
  }, [titles, fetchMeta])

  return (
    <div className="mx-auto max-w-[1600px] px-4 py-6 lg:px-6 lg:py-8">
      {!loading && (
        <p className="mb-6 text-sm text-muted-foreground">
          {total} {total === 1 ? "title" : "titles"}
        </p>
      )}

      {loading ? (
        <div className="grid grid-cols-2 gap-4 md:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5">
          {Array.from({ length: 20 }).map((_, i) => (
            <Skeleton key={i} className="aspect-[2/3] rounded-xl" />
          ))}
        </div>
      ) : titles.length === 0 ? (
        <div className="flex flex-col items-center justify-center py-20 text-center">
          <Search className="mb-4 size-12 text-muted-foreground/50" />
          <h2 className="mb-1 text-lg font-medium">Your library is empty</h2>
          <p className="text-sm text-muted-foreground">
            Search for movies or TV shows to start building your library.
          </p>
        </div>
      ) : (
        <>
          <div className="grid grid-cols-2 gap-4 md:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5">
            {titles.map((title) => {
              const info = meta[tmdbKey(title.mediaType, title.tmdbId)]
              if (!info) return <Skeleton key={title.id} className="aspect-[2/3] rounded-xl" />

              const latest = latestStatus(title)
              return (
                <div key={title.id} className="relative">
                  <MediaCard
                    title={info.title}
                    year={info.year}
                    posterPath={info.posterPath}
                    mediaType={title.mediaType}
                    onClick={() =>
                      setTitleItem({
                        id: title.tmdbId,
                        mediaType: title.mediaType,
                        title: info.title,
                        posterPath: info.posterPath,
                        voteAverage: 0,
                        year: info.year,
                      })
                    }
                  />
                  {latest && (
                    <StatusBadge status={DOWNLOAD_STATUS[latest]} className="pointer-events-none absolute top-2 left-2 shadow" />
                  )}
                </div>
              )
            })}
          </div>
          <div ref={sentinel} className="h-1" />
        </>
      )}

      {titleItem && (
        <TitleDialog
          item={titleItem}
          onClose={() => setTitleItem(null)}
          onItemClick={(item) => setTitleItem(item)}
        />
      )}
    </div>
  )
}

/** The status of a title's most recent download, which is what its poster shows. */
function latestStatus(title: TitleSummary): DownloadStatus | null {
  return title.downloads[0]?.status ?? null
}
