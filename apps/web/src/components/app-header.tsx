import { useState, useRef, useEffect } from "react"
import { NavLink, useNavigate } from "react-router-dom"
import { Search, ChevronDown, Film, Tv, Loader2 } from "lucide-react"
import { auth } from "@/lib/auth"
import { useTMDBSearch, fetchIMDbId, fetchTMDBByImdbId, type TMDBResult, type TMDBMeta } from "@/hooks/use-tmdb-search"
import { MediaDetailDialog } from "@/components/media-detail-dialog"
import { IndexDialog } from "@/components/index-dialog"
import type { TMDBDiscoverItem } from "@/hooks/use-tmdb-trending"
import type { IndexWithTorrents } from "@findr/types"

const TMDB_IMAGE = "https://image.tmdb.org/t/p/w92"
const TMDB_IMAGE_FULL = "https://image.tmdb.org/t/p/original"

export function AppHeader() {
  const navigate = useNavigate()
  const { data: session } = auth.useSession()

  const [query, setQuery] = useState("")
  const [dropdownOpen, setDropdownOpen] = useState(false)
  const { results, loading } = useTMDBSearch(query)
  const containerRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)

  // Discover dialog state
  const [discoverItem, setDiscoverItem] = useState<TMDBDiscoverItem | null>(null)
  const [discoverOpen, setDiscoverOpen] = useState(false)

  // Library dialog state
  const [libraryIndexes, setLibraryIndexes] = useState<IndexWithTorrents[]>([])
  const [libraryMeta, setLibraryMeta] = useState<TMDBMeta | null>(null)
  const [libraryOpen, setLibraryOpen] = useState(false)

  const [selecting, setSelecting] = useState<number | null>(null)

  const initials = session?.user?.name
    ? session.user.name
        .split(" ")
        .map((n: string) => n[0])
        .join("")
        .toUpperCase()
        .slice(0, 2)
    : "?"

  async function handleSignOut() {
    await auth.signOut()
    navigate("/login")
  }

  // Close dropdown on outside click
  useEffect(() => {
    function handleClick(e: MouseEvent) {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setDropdownOpen(false)
      }
    }
    document.addEventListener("mousedown", handleClick)
    return () => document.removeEventListener("mousedown", handleClick)
  }, [])

  // Show dropdown when results arrive
  useEffect(() => {
    if (results.length > 0 && query.trim().length >= 2) {
      setDropdownOpen(true)
    }
  }, [results, query])

  async function handleSelect(result: TMDBResult) {
    setSelecting(result.id)
    setDropdownOpen(false)

    try {
      const imdbId = await fetchIMDbId(result.id, result.mediaType)
      if (!imdbId) {
        openAsDiscover(result)
        return
      }

      // Check if indexed
      const res = await fetch("/api/indexes", { credentials: "include" })
      if (!res.ok) {
        openAsDiscover(result)
        return
      }

      const allIndexes: IndexWithTorrents[] = await res.json()
      const matching = allIndexes.filter((idx) => idx.imdbId === imdbId)

      if (matching.length > 0) {
        const meta = await fetchTMDBByImdbId(imdbId)
        setLibraryIndexes(matching.sort((a, b) => (a.season ?? 0) - (b.season ?? 0)))
        setLibraryMeta(meta)
        setLibraryOpen(true)
      } else {
        openAsDiscover(result)
      }
    } catch {
      openAsDiscover(result)
    } finally {
      setSelecting(null)
      setQuery("")
    }
  }

  function openAsDiscover(result: TMDBResult) {
    setDiscoverItem({
      id: result.id,
      title: result.title,
      mediaType: result.mediaType,
      year: result.year,
      releaseDate: result.releaseDate,
      rating: result.rating,
      posterPath: result.posterPath ? `${TMDB_IMAGE_FULL}${result.posterPath}` : null,
      overview: result.overview,
    })
    setDiscoverOpen(true)
    setQuery("")
  }

  return (
    <>
      <header className="fixed top-0 left-0 right-0 h-16 bg-findr-surface border-b border-findr-border z-50">
        <div className="h-full px-6 flex items-center justify-between max-w-[1600px] mx-auto">
          {/* Left: Logo & Nav */}
          <div className="flex items-center gap-10">
            <NavLink to="/" className="flex items-center gap-3">
              <img
                src="/findr-icon.png"
                alt="Findr"
                className="h-8"
              />
              <span className="text-xl font-extrabold tracking-tight text-findr-amber">
                Findr
              </span>
            </NavLink>

            <nav className="hidden md:flex items-center gap-6 h-16">
              <NavLink
                to="/"
                end
                className={({ isActive }) =>
                  `text-sm font-semibold transition-colors h-full flex items-center relative ${
                    isActive
                      ? "text-findr-text"
                      : "text-findr-secondary hover:text-findr-text"
                  }`
                }
              >
                {({ isActive }) => (
                  <>
                    Library
                    {isActive && (
                      <div className="absolute bottom-0 left-0 right-0 h-0.5 bg-findr-amber" />
                    )}
                  </>
                )}
              </NavLink>
              <NavLink
                to="/discover"
                className={({ isActive }) =>
                  `text-sm font-semibold transition-colors h-full flex items-center relative ${
                    isActive
                      ? "text-findr-text"
                      : "text-findr-secondary hover:text-findr-text"
                  }`
                }
              >
                {({ isActive }) => (
                  <>
                    Discover
                    {isActive && (
                      <div className="absolute bottom-0 left-0 right-0 h-0.5 bg-findr-amber" />
                    )}
                  </>
                )}
              </NavLink>
              <NavLink
                to="/jobs"
                className={({ isActive }) =>
                  `text-sm font-semibold transition-colors h-full flex items-center relative ${
                    isActive
                      ? "text-findr-text"
                      : "text-findr-secondary hover:text-findr-text"
                  }`
                }
              >
                {({ isActive }) => (
                  <>
                    Jobs
                    {isActive && (
                      <div className="absolute bottom-0 left-0 right-0 h-0.5 bg-findr-amber" />
                    )}
                  </>
                )}
              </NavLink>
            </nav>
          </div>

          {/* Center: Search */}
          <div className="flex-1 max-w-md mx-8 hidden lg:block" ref={containerRef}>
            <div className="relative group">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 text-findr-tertiary size-4 transition-colors group-focus-within:text-findr-amber z-10" />
              <input
                ref={inputRef}
                type="text"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                onFocus={() => { if (results.length > 0) setDropdownOpen(true) }}
                placeholder="Search movies & TV shows..."
                className="w-full h-10 bg-[#F5F5F5] border border-transparent hover:border-findr-border rounded-md pl-10 pr-4 text-sm text-findr-text placeholder:text-findr-tertiary focus:bg-white focus:outline-none focus:border-findr-amber focus:ring-1 focus:ring-findr-amber/20 transition-all duration-200"
              />

              {/* Autocomplete dropdown */}
              {dropdownOpen && query.trim().length >= 2 && (
                <div className="absolute top-full left-0 right-0 mt-1 bg-white border border-findr-border rounded-xl shadow-lg overflow-hidden z-50">
                  {loading && (
                    <div className="flex items-center justify-center py-4">
                      <Loader2 className="size-4 animate-spin text-findr-amber" />
                    </div>
                  )}

                  {!loading && results.length > 0 && (
                    <div className="max-h-80 overflow-y-auto py-1">
                      {results.map((result) => (
                        <button
                          key={`${result.mediaType}-${result.id}`}
                          onClick={() => handleSelect(result)}
                          disabled={selecting !== null}
                          className="flex w-full items-center gap-3 px-3 py-2 text-left transition-colors hover:bg-findr-hover disabled:opacity-50"
                        >
                          {result.posterPath ? (
                            <img
                              src={`${TMDB_IMAGE}${result.posterPath}`}
                              alt=""
                              className="h-12 w-8 rounded object-cover shrink-0"
                            />
                          ) : (
                            <div className="flex h-12 w-8 items-center justify-center rounded bg-findr-hover shrink-0">
                              {result.mediaType === "movie" ? (
                                <Film className="size-4 text-findr-tertiary" />
                              ) : (
                                <Tv className="size-4 text-findr-tertiary" />
                              )}
                            </div>
                          )}
                          <div className="flex-1 min-w-0">
                            <p className="truncate text-sm font-semibold text-findr-text">
                              {result.title}
                            </p>
                            <div className="flex items-center gap-2 mt-0.5">
                              {result.year && (
                                <span className="text-xs text-findr-secondary">{result.year}</span>
                              )}
                              <span className={`text-[10px] font-bold uppercase tracking-widest px-1.5 py-0.5 rounded-full ${
                                result.mediaType === "movie"
                                  ? "bg-[rgba(34,197,94,0.15)] text-findr-success"
                                  : "bg-[rgba(245,168,38,0.15)] text-findr-amber"
                              }`}>
                                {result.mediaType === "movie" ? "Movie" : "Series"}
                              </span>
                            </div>
                          </div>
                          {selecting === result.id && (
                            <Loader2 className="size-4 animate-spin text-findr-amber shrink-0" />
                          )}
                        </button>
                      ))}
                    </div>
                  )}

                  {!loading && query.length >= 2 && results.length === 0 && (
                    <p className="py-4 text-center text-xs text-findr-secondary">
                      No results found
                    </p>
                  )}
                </div>
              )}
            </div>
          </div>

          {/* Right: Account */}
          <div className="flex items-center gap-4">
            <div className="relative group">
              <button
                onClick={handleSignOut}
                className="flex items-center gap-2 hover:opacity-80 transition-opacity p-1 rounded-full"
              >
                <div className="w-9 h-9 rounded-full bg-[#FFF4E5] border border-[#FFE0B2] flex items-center justify-center text-findr-amber font-bold text-sm shadow-sm">
                  {initials}
                </div>
                <ChevronDown className="text-findr-secondary size-3.5 hidden sm:block" />
              </button>
            </div>
          </div>
        </div>
      </header>

      {/* Discover dialog (not yet indexed) */}
      <MediaDetailDialog
        item={discoverItem}
        open={discoverOpen}
        onOpenChange={setDiscoverOpen}
        onIndexed={() => navigate("/jobs")}
      />

      {/* Library dialog (already indexed) */}
      <IndexDialog
        indexes={libraryIndexes}
        meta={libraryMeta}
        open={libraryOpen}
        onOpenChange={setLibraryOpen}
        onRedownloaded={() => {
          setLibraryOpen(false)
          navigate("/jobs")
        }}
        onRemoved={() => {
          setLibraryOpen(false)
          navigate("/")
        }}
        onReindexed={() => {
          setLibraryOpen(false)
          navigate("/jobs")
        }}
        onSeasonIndexed={() => {
          setLibraryOpen(false)
          navigate("/jobs")
        }}
      />
    </>
  )
}
