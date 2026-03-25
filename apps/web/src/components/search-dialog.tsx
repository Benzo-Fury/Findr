import { useState } from "react"
import { Search, Film, Tv, Loader2 } from "lucide-react"
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { useTMDBSearch, fetchIMDbId, type TMDBResult } from "@/hooks/use-tmdb-search"

const TMDB_IMAGE = "https://image.tmdb.org/t/p/w92"

interface SearchDialogProps {
  onJobCreated: () => void
}

export function SearchDialog({ onJobCreated }: SearchDialogProps) {
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState("")
  const [creating, setCreating] = useState<number | null>(null)
  const [error, setError] = useState("")
  const { results, loading } = useTMDBSearch(query)

  async function handleSelect(result: TMDBResult) {
    setError("")
    setCreating(result.id)

    try {
      const imdbId = await fetchIMDbId(result.id, result.mediaType)
      if (!imdbId) {
        setError("Could not find IMDb ID for this title")
        setCreating(null)
        return
      }

      const res = await fetch("/api/jobs/create", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({
          imdbId,
          ...(result.mediaType === "tv" ? { season: 1 } : {}),
        }),
      })

      if (!res.ok) {
        const data = await res.json().catch(() => null)
        throw new Error(data?.message ?? `Request failed (${res.status})`)
      }

      setOpen(false)
      setQuery("")
      onJobCreated()
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to create job")
    } finally {
      setCreating(null)
    }
  }

  return (
    <Dialog open={open} onOpenChange={(v) => { setOpen(v); if (!v) { setQuery(""); setError("") } }}>
      <DialogTrigger asChild>
        <Button>
          <Search className="size-4" />
          Search
        </Button>
      </DialogTrigger>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Find a movie or series</DialogTitle>
        </DialogHeader>
        <div className="space-y-3">
          <div className="relative">
            <Search className="absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              placeholder="Search movies & TV shows..."
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              className="pl-9"
              autoFocus
            />
          </div>

          {error && (
            <p className="text-sm text-destructive">{error}</p>
          )}

          {loading && (
            <div className="flex items-center justify-center py-6 text-muted-foreground">
              <Loader2 className="size-4 animate-spin" />
            </div>
          )}

          {!loading && results.length > 0 && (
            <div className="max-h-80 space-y-1 overflow-y-auto">
              {results.map((result) => (
                <button
                  key={`${result.mediaType}-${result.id}`}
                  onClick={() => handleSelect(result)}
                  disabled={creating !== null}
                  className="flex w-full items-center gap-3 rounded-md px-3 py-2 text-left transition-colors hover:bg-accent disabled:opacity-50"
                >
                  {result.posterPath ? (
                    <img
                      src={`${TMDB_IMAGE}${result.posterPath}`}
                      alt=""
                      className="h-14 w-10 rounded object-cover"
                    />
                  ) : (
                    <div className="flex h-14 w-10 items-center justify-center rounded bg-muted">
                      {result.mediaType === "movie" ? (
                        <Film className="size-4 text-muted-foreground" />
                      ) : (
                        <Tv className="size-4 text-muted-foreground" />
                      )}
                    </div>
                  )}
                  <div className="flex-1 min-w-0">
                    <p className="truncate font-medium text-sm">
                      {result.title}
                    </p>
                    <div className="flex items-center gap-2 mt-0.5">
                      {result.year && (
                        <span className="text-xs text-muted-foreground">{result.year}</span>
                      )}
                      <Badge variant="secondary" className="text-[10px] px-1.5 py-0">
                        {result.mediaType === "movie" ? "Movie" : "Series"}
                      </Badge>
                    </div>
                  </div>
                  {creating === result.id && (
                    <Loader2 className="size-4 animate-spin text-muted-foreground" />
                  )}
                </button>
              ))}
            </div>
          )}

          {!loading && query.length >= 2 && results.length === 0 && (
            <p className="py-6 text-center text-sm text-muted-foreground">
              No results found
            </p>
          )}
        </div>
      </DialogContent>
    </Dialog>
  )
}
