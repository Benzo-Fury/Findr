import * as React from "react"
import { Search } from "lucide-react"
import { MediaCard } from "@/components/media-card"
import { Skeleton } from "@/components/ui/skeleton"
import { TitleDialog } from "@/components/title-dialog"
import { fetchIndexes } from "@/lib/api"
import { useTMDBMeta } from "@/lib/hooks"
import type { IndexWithTorrents, PosterItem } from "@/lib/types"

/**
 * Everything the user has indexed.
 *
 * Indexes are stored per season, so several rows can belong to one title. They
 * are grouped by IMDb ID and rendered as a single poster, with artwork and
 * names resolved from TMDB since the index rows carry neither.
 */
export function LibraryPage() {
  const [indexes, setIndexes] = React.useState<IndexWithTorrents[]>([])
  const [loading, setLoading] = React.useState(true)
  const { meta, loadingIds, fetchMeta } = useTMDBMeta()
  const [titleItem, setTitleItem] = React.useState<PosterItem | null>(null)

  React.useEffect(() => {
    fetchIndexes()
      .then(setIndexes)
      .catch(() => {})
      .finally(() => setLoading(false))
  }, [])

  React.useEffect(() => {
    const uniqueImdbIds = [...new Set(indexes.map((index) => index.imdbId))]
    uniqueImdbIds.forEach(fetchMeta)
  }, [indexes, fetchMeta])

  const grouped = React.useMemo(() => {
    const byImdbId = new Map<string, IndexWithTorrents[]>()

    for (const index of indexes) {
      const existing = byImdbId.get(index.imdbId) ?? []
      existing.push(index)
      byImdbId.set(index.imdbId, existing)
    }

    return Array.from(byImdbId.entries()).map(([imdbId, entries]) => ({
      imdbId,
      indexes: entries,
      meta: meta[imdbId],
    }))
  }, [indexes, meta])

  return (
    <div className="mx-auto max-w-[1600px] px-4 py-6 lg:px-6 lg:py-8">
      <div className="mb-6 flex items-center justify-between">
        {!loading && (
          <span className="text-sm text-muted-foreground">
            {grouped.length} {grouped.length === 1 ? "title" : "titles"}
          </span>
        )}
      </div>

      {loading ? (
        <div className="grid grid-cols-2 gap-4 md:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5">
          {Array.from({ length: 20 }).map((_, i) => (
            <Skeleton key={i} className="aspect-[2/3] rounded-xl" />
          ))}
        </div>
      ) : grouped.length === 0 ? (
        <div className="flex flex-col items-center justify-center py-20 text-center">
          <Search className="mb-4 size-12 text-muted-foreground/50" />
          <h2 className="mb-1 text-lg font-medium">Your library is empty</h2>
          <p className="text-sm text-muted-foreground">
            Search for movies or TV shows to start building your library.
          </p>
        </div>
      ) : (
        <div className="grid grid-cols-2 gap-4 md:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5">
          {grouped.map((group) =>
            !group.meta && loadingIds.has(group.imdbId) ? (
              <Skeleton key={group.imdbId} className="aspect-[2/3] rounded-xl" />
            ) : (
              <MediaCard
                key={group.imdbId}
                title={group.meta?.title || group.imdbId}
                year={group.meta?.year}
                posterPath={group.meta?.posterPath ?? null}
                mediaType={group.meta?.mediaType || "movie"}
                onClick={() => {
                  if (!group.meta) return
                  setTitleItem({
                    id: group.meta.tmdbId,
                    mediaType: group.meta.mediaType,
                    title: group.meta.title,
                    posterPath: group.meta.posterPath,
                    voteAverage: 0,
                    year: group.meta.year,
                  })
                }}
              />
            ),
          )}
        </div>
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
