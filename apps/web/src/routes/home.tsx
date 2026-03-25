import { useState, useEffect, useCallback } from "react"
import { useNavigate, Navigate, NavLink } from "react-router-dom"
import { Film, Tv, LogOut, Briefcase } from "lucide-react"
import { auth } from "@/lib/auth"
import { Button } from "@/components/ui/button"
import { Skeleton } from "@/components/ui/skeleton"
import { SearchDialog } from "@/components/search-dialog"
import { IndexDialog } from "@/components/index-dialog"
import { fetchTMDBByImdbId, type TMDBMeta } from "@/hooks/use-tmdb-search"
import type { IndexWithTorrents } from "@findr/types"

const TMDB_IMAGE = "https://image.tmdb.org/t/p/w342"

export default function Home() {
  const navigate = useNavigate()
  const { data: session, isPending } = auth.useSession()
  const [indexes, setIndexes] = useState<IndexWithTorrents[]>([])
  const [meta, setMeta] = useState<Record<string, TMDBMeta>>({})
  const [loadingIndexes, setLoadingIndexes] = useState(true)
  const [selectedIndex, setSelectedIndex] = useState<IndexWithTorrents | null>(null)
  const [dialogOpen, setDialogOpen] = useState(false)

  const fetchIndexes = useCallback(async () => {
    try {
      const res = await fetch("/api/indexes", { credentials: "include" })
      if (res.ok) {
        const data: IndexWithTorrents[] = await res.json()
        setIndexes(data)
        // Fetch TMDB metadata for any new imdbIds
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

  async function handleSignOut() {
    await auth.signOut()
    navigate("/login")
  }

  function openIndex(idx: IndexWithTorrents) {
    setSelectedIndex(idx)
    setDialogOpen(true)
  }

  return (
    <div className="mx-auto min-h-screen max-w-5xl px-4 py-8">
      <header className="mb-8 flex items-center justify-between">
        <div className="flex items-center gap-6">
          <h1 className="text-xl font-bold tracking-tight">Findr</h1>
          <nav className="flex items-center gap-4">
            <NavLink
              to="/"
              end
              className={({ isActive }) =>
                `text-sm transition-colors ${isActive ? "text-foreground font-medium" : "text-muted-foreground hover:text-foreground"}`
              }
            >
              Library
            </NavLink>
            <NavLink
              to="/jobs"
              className={({ isActive }) =>
                `text-sm transition-colors ${isActive ? "text-foreground font-medium" : "text-muted-foreground hover:text-foreground"}`
              }
            >
              Jobs
            </NavLink>
          </nav>
        </div>
        <div className="flex items-center gap-2">
          <SearchDialog onJobCreated={() => navigate("/jobs")} />
          <Button variant="ghost" size="icon" onClick={handleSignOut}>
            <LogOut className="size-4" />
          </Button>
        </div>
      </header>

      {loadingIndexes ? (
        <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-4">
          {Array.from({ length: 8 }).map((_, i) => (
            <div key={i} className="space-y-2">
              <Skeleton className="aspect-[2/3] w-full rounded-md" />
              <Skeleton className="h-4 w-3/4" />
              <Skeleton className="h-3 w-1/2" />
            </div>
          ))}
        </div>
      ) : indexes.length === 0 ? (
        <div className="flex flex-col items-center justify-center py-24 text-center">
          <Film className="size-12 text-muted-foreground/40 mb-4" />
          <p className="text-sm font-medium text-muted-foreground">Library is empty</p>
          <p className="text-xs text-muted-foreground/70 mt-1">
            Search for a movie or series to index it
          </p>
        </div>
      ) : (
        <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-4">
          {indexes.map((idx) => {
            const m = meta[idx.imdbId]
            return (
              <button
                key={idx.id}
                onClick={() => openIndex(idx)}
                className="group text-left"
              >
                <div className="overflow-hidden rounded-md bg-muted aspect-[2/3] mb-2 transition-all group-hover:ring-2 group-hover:ring-primary/50">
                  {m?.posterPath ? (
                    <img
                      src={`${TMDB_IMAGE}${m.posterPath}`}
                      alt=""
                      className="h-full w-full object-cover transition-transform group-hover:scale-105"
                    />
                  ) : (
                    <div className="flex h-full w-full items-center justify-center">
                      {m?.mediaType === "tv" ? (
                        <Tv className="size-8 text-muted-foreground/40" />
                      ) : (
                        <Film className="size-8 text-muted-foreground/40" />
                      )}
                    </div>
                  )}
                </div>
                <p className="truncate text-sm font-medium">{m?.title ?? idx.imdbId}</p>
                <p className="text-xs text-muted-foreground">
                  {m?.year ?? ""}
                  {idx.season != null ? ` · S${idx.season}` : ""}
                </p>
              </button>
            )
          })}
        </div>
      )}

      <IndexDialog
        index={selectedIndex}
        meta={selectedIndex ? (meta[selectedIndex.imdbId] ?? null) : null}
        open={dialogOpen}
        onOpenChange={setDialogOpen}
        onRedownloaded={fetchIndexes}
      />
    </div>
  )
}
