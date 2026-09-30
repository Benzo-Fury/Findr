import * as React from "react"
import { Search, Film, Tv, Loader2, X } from "lucide-react"
import { Dialog, DialogContent } from "@/components/ui/dialog"
import { Badge } from "@/components/ui/badge"
import { searchTMDB } from "@/lib/api"
import type { PosterItem } from "@/lib/types"

/**
 * Title search. The API returns results already narrowed to movies and shows
 * in the same poster shape the grids use, so a pick can be handed straight to
 * the title dialog.
 */

interface SearchDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  onSelectItem?: (item: PosterItem) => void
}

const POSTER_BASE = "https://image.tmdb.org/t/p/w92"

/** Wait for typing to settle before spending a request. */
const DEBOUNCE_MS = 300

export function SearchDialog({ open, onOpenChange, onSelectItem }: SearchDialogProps) {
  const [query, setQuery] = React.useState("")
  const [results, setResults] = React.useState<PosterItem[]>([])
  const [searching, setSearching] = React.useState(false)
  const inputRef = React.useRef<HTMLInputElement>(null)
  const debounceRef = React.useRef<ReturnType<typeof setTimeout>>(undefined)

  React.useEffect(() => {
    if (open) {
      setQuery("")
      setResults([])
      setTimeout(() => inputRef.current?.focus(), 50)
    }
  }, [open])

  function handleSearch(value: string) {
    setQuery(value)
    clearTimeout(debounceRef.current)

    if (value.trim().length < 2) {
      setResults([])
      return
    }

    debounceRef.current = setTimeout(async () => {
      setSearching(true)
      try {
        const data = await searchTMDB(value)
        setResults(data.results.slice(0, 8))
      } catch {
        setResults([])
      }
      setSearching(false)
    }, DEBOUNCE_MS)
  }

  function handleSelect(item: PosterItem) {
    onOpenChange(false)
    onSelectItem?.(item)
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md gap-0 overflow-hidden p-0">
        <div className="flex items-center gap-2 border-b px-3">
          <Search className="size-4 shrink-0 text-muted-foreground" />
          <input
            ref={inputRef}
            value={query}
            onChange={(e) => handleSearch(e.target.value)}
            placeholder="Search movies and TV shows..."
            className="flex-1 bg-transparent py-3 text-sm outline-none placeholder:text-muted-foreground"
          />
          {searching && (
            <Loader2 className="size-4 shrink-0 animate-spin text-muted-foreground" />
          )}
          <button
            onClick={() => onOpenChange(false)}
            className="rounded-md p-1 text-muted-foreground hover:text-foreground"
          >
            <X className="size-4" />
          </button>
        </div>

        {results.length > 0 && (
          <div className="max-h-80 overflow-y-auto p-1">
            {results.map((item) => (
              <button
                key={`${item.mediaType}-${item.id}`}
                onClick={() => handleSelect(item)}
                className="flex w-full items-center gap-3 rounded-lg px-2 py-2 text-left transition-colors hover:bg-muted"
              >
                {item.posterPath ? (
                  <img
                    src={`${POSTER_BASE}${item.posterPath}`}
                    alt={item.title}
                    className="size-10 rounded object-cover"
                  />
                ) : (
                  <div className="flex size-10 items-center justify-center rounded bg-muted">
                    {item.mediaType === "movie" ? (
                      <Film className="size-4 text-muted-foreground" />
                    ) : (
                      <Tv className="size-4 text-muted-foreground" />
                    )}
                  </div>
                )}

                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-medium">{item.title}</p>
                  <p className="text-xs text-muted-foreground">{item.year}</p>
                </div>

                <Badge variant={item.mediaType === "movie" ? "success" : "warning"}>
                  {item.mediaType === "movie" ? "Movie" : "Series"}
                </Badge>
              </button>
            ))}
          </div>
        )}

        {query.trim().length >= 2 && !searching && results.length === 0 && (
          <div className="py-8 text-center text-sm text-muted-foreground">
            No results found
          </div>
        )}
      </DialogContent>
    </Dialog>
  )
}
