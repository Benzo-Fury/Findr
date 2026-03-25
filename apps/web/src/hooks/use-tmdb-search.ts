import { useState, useEffect, useRef } from "react"

export interface TMDBResult {
  id: number
  title: string
  mediaType: "movie" | "tv"
  year: string
  posterPath: string | null
  imdbId?: string
}

const TMDB_API_KEY = import.meta.env.VITE_TMDB_API_KEY as string
const TMDB_BASE = "https://api.themoviedb.org/3"

export function useTMDBSearch(query: string) {
  const [results, setResults] = useState<TMDBResult[]>([])
  const [loading, setLoading] = useState(false)
  const debounceRef = useRef<ReturnType<typeof setTimeout>>(null)

  useEffect(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current)

    if (query.trim().length < 2) {
      setResults([])
      setLoading(false)
      return
    }

    setLoading(true)

    debounceRef.current = setTimeout(async () => {
      try {
        const res = await fetch(
          `${TMDB_BASE}/search/multi?api_key=${TMDB_API_KEY}&query=${encodeURIComponent(query)}&include_adult=false`
        )
        const data = await res.json()

        const mapped: TMDBResult[] = (data.results ?? [])
          .filter((r: any) => r.media_type === "movie" || r.media_type === "tv")
          .slice(0, 8)
          .map((r: any) => ({
            id: r.id,
            title: r.media_type === "movie" ? r.title : r.name,
            mediaType: r.media_type as "movie" | "tv",
            year: (r.media_type === "movie" ? r.release_date : r.first_air_date)?.slice(0, 4) ?? "",
            posterPath: r.poster_path,
          }))

        setResults(mapped)
      } catch {
        setResults([])
      } finally {
        setLoading(false)
      }
    }, 300)

    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current)
    }
  }, [query])

  return { results, loading }
}

export interface TMDBMeta {
  title: string
  year: string
  posterPath: string | null
  overview: string
  mediaType: "movie" | "tv"
}

/** Looks up TMDB metadata for a known IMDb ID using the /find endpoint. */
export async function fetchTMDBByImdbId(imdbId: string): Promise<TMDBMeta | null> {
  try {
    const res = await fetch(
      `${TMDB_BASE}/find/${imdbId}?external_source=imdb_id&api_key=${TMDB_API_KEY}`
    )
    const data = await res.json()
    const movie = data.movie_results?.[0]
    const tv = data.tv_results?.[0]
    const item = movie ?? tv
    if (!item) return null
    return {
      title: movie ? item.title : item.name,
      year: (movie ? item.release_date : item.first_air_date)?.slice(0, 4) ?? "",
      posterPath: item.poster_path ?? null,
      overview: item.overview ?? "",
      mediaType: movie ? "movie" : "tv",
    }
  } catch {
    return null
  }
}

export async function fetchIMDbId(tmdbId: number, mediaType: "movie" | "tv"): Promise<string | null> {
  try {
    const res = await fetch(
      `${TMDB_BASE}/${mediaType}/${tmdbId}/external_ids?api_key=${TMDB_API_KEY}`
    )
    const data = await res.json()
    return data.imdb_id ?? null
  } catch {
    return null
  }
}
