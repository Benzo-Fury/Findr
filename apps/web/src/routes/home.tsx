import { useState, useEffect, useCallback } from "react"
import { useNavigate, Navigate } from "react-router-dom"
import { Film, Tv } from "lucide-react"
import { auth } from "@/lib/auth"
import { Skeleton } from "@/components/ui/skeleton"
import { SearchDialog } from "@/components/search-dialog"
import { IndexDialog } from "@/components/index-dialog"
import { fetchTMDBByImdbId, type TMDBMeta } from "@/hooks/use-tmdb-search"
import type { IndexWithTorrents } from "@findr/types"

interface GroupedIndex {
  imdbId: string
  indexes: IndexWithTorrents[]
}

const TMDB_IMAGE = "https://image.tmdb.org/t/p/w342"

export default function Home() {
  const navigate = useNavigate()
  const { data: session, isPending } = auth.useSession()
  const [indexes, setIndexes] = useState<IndexWithTorrents[]>([])
  const [meta, setMeta] = useState<Record<string, TMDBMeta>>({})
  const [loadingIndexes, setLoadingIndexes] = useState(true)
  const [selectedGroup, setSelectedGroup] = useState<GroupedIndex | null>(null)
  const [dialogOpen, setDialogOpen] = useState(false)

  const fetchIndexes = useCallback(async () => {
    try {
      const res = await fetch("/api/indexes", { credentials: "include" })
      if (res.ok) {
        const data: IndexWithTorrents[] = await res.json()
        setIndexes(data)
        const unknown = data.filter((idx) => !meta[idx.imdbId])
        await Promise.all(
          unknown.map(async (idx) => {
            const m = await fetchTMDBByImdbId(idx.imdbId)
            if (m) setMeta((prev) => ({ ...prev, [idx.imdbId]: m }))
          })
        )
      }
    } catch {
      // silently fail
    } finally {
      setLoadingIndexes(false)
    }
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!session) return
    fetchIndexes()
  }, [session, fetchIndexes])

  if (isPending) return null
  if (!session) return <Navigate to="/login" replace />

  const grouped: GroupedIndex[] = (() => {
    const map = new Map<string, IndexWithTorrents[]>()
    for (const idx of indexes) {
      const existing = map.get(idx.imdbId)
      if (existing) existing.push(idx)
      else map.set(idx.imdbId, [idx])
    }
    return Array.from(map, ([imdbId, idxs]) => ({
      imdbId,
      indexes: idxs.sort((a, b) => (a.season ?? 0) - (b.season ?? 0)),
    }))
  })()

  function openGroup(group: GroupedIndex) {
    setSelectedGroup(group)
    setDialogOpen(true)
  }

  return (
    <div className="max-w-[1600px] mx-auto">
      {/* Page Header */}
      <div className="sticky top-16 bg-findr-bg/95 backdrop-blur-md z-40 border-b border-findr-border">
        <div className="px-6 py-6 md:py-8 flex items-center justify-between">
          <div>
            <h1 className="text-3xl font-extrabold tracking-tight text-findr-text mb-2">
              Library
            </h1>
            <p className="text-findr-secondary text-sm font-medium">
              Your indexed movies and TV shows.
            </p>
          </div>
          <SearchDialog onJobCreated={() => navigate("/jobs")} />
        </div>
      </div>

      <div className="p-6 md:p-8">
        {loadingIndexes ? (
          <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5 gap-5 md:gap-6">
            {Array.from({ length: 10 }).map((_, i) => (
              <div key={i} className="aspect-[2/3]">
                <Skeleton className="w-full h-full rounded-xl" />
              </div>
            ))}
          </div>
        ) : indexes.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-24 text-center">
            <Film className="size-12 text-findr-tertiary/40 mb-4" />
            <p className="text-sm font-medium text-findr-secondary">
              Library is empty
            </p>
            <p className="text-xs text-findr-tertiary mt-1">
              Search for a movie or series to index it
            </p>
          </div>
        ) : (
          <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5 gap-5 md:gap-6">
            {grouped.map((group) => {
              const m = meta[group.imdbId]
              const seasonCount = group.indexes.filter((i) => i.season != null).length
              return (
                <button
                  key={group.imdbId}
                  onClick={() => openGroup(group)}
                  className="group text-left"
                >
                  <div className="overflow-hidden rounded-xl bg-findr-hover aspect-[2/3] mb-2 border border-findr-border transition-all group-hover:shadow-lg group-hover:border-findr-amber/40">
                    {m?.posterPath ? (
                      <img
                        src={`${TMDB_IMAGE}${m.posterPath}`}
                        alt=""
                        className="h-full w-full object-cover transition-transform duration-500 group-hover:scale-105"
                      />
                    ) : (
                      <div className="flex h-full w-full items-center justify-center">
                        {m?.mediaType === "tv" ? (
                          <Tv className="size-8 text-findr-tertiary/40" />
                        ) : (
                          <Film className="size-8 text-findr-tertiary/40" />
                        )}
                      </div>
                    )}
                  </div>
                  <p className="truncate text-sm font-semibold text-findr-text">
                    {m?.title ?? group.imdbId}
                  </p>
                  <p className="text-xs text-findr-secondary">
                    {m?.year ?? ""}
                    {seasonCount > 0 ? ` · ${seasonCount} season${seasonCount > 1 ? "s" : ""}` : ""}
                  </p>
                </button>
              )
            })}
          </div>
        )}
      </div>

      <IndexDialog
        indexes={selectedGroup?.indexes ?? []}
        meta={selectedGroup ? (meta[selectedGroup.imdbId] ?? null) : null}
        open={dialogOpen}
        onOpenChange={setDialogOpen}
        onRedownloaded={() => {
          setDialogOpen(false)
          navigate("/jobs")
        }}
        onRemoved={() => fetchIndexes()}
        onReindexed={() => navigate("/jobs")}
        onSeasonIndexed={() => navigate("/jobs")}
      />
    </div>
  )
}
