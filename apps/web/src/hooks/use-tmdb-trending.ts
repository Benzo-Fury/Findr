import { useState, useEffect, useRef, useCallback } from "react"

export interface TMDBDiscoverItem {
  id: number
  title: string
  mediaType: "movie" | "tv"
  year: string
  releaseDate: string
  rating: number
  posterPath: string | null
  overview: string
}

export type DiscoverTab = "trending" | "top_rated"

export const TMDB_API_KEY = import.meta.env.VITE_TMDB_API_KEY as string
export const TMDB_BASE = "https://api.themoviedb.org/3"
const TMDB_IMAGE = "https://image.tmdb.org/t/p/original"

function mapResult(r: any, mediaType?: "movie" | "tv"): TMDBDiscoverItem {
  const type = mediaType ?? r.media_type
  const rawDate = (type === "movie" ? r.release_date : r.first_air_date) ?? ""
  return {
    id: r.id,
    title: type === "movie" ? r.title : r.name,
    mediaType: type,
    year: rawDate.slice(0, 4),
    releaseDate: rawDate,
    rating: Math.round((r.vote_average ?? 0) * 10) / 10,
    posterPath: r.poster_path ? `${TMDB_IMAGE}${r.poster_path}` : null,
    overview: r.overview ?? "",
  }
}

async function fetchTrendingPage(page: number): Promise<{ items: TMDBDiscoverItem[]; hasMore: boolean }> {
  const res = await fetch(
    `${TMDB_BASE}/trending/all/week?api_key=${TMDB_API_KEY}&page=${page}`
  )
  const data = await res.json()
  const items = (data.results ?? [])
    .filter((r: any) => r.media_type === "movie" || r.media_type === "tv")
    .map((r: any) => mapResult(r))
  return { items, hasMore: page < (data.total_pages ?? 1) }
}

async function fetchTopRatedPage(page: number): Promise<{ items: TMDBDiscoverItem[]; hasMore: boolean }> {
  const [moviesRes, tvRes] = await Promise.all([
    fetch(`${TMDB_BASE}/movie/top_rated?api_key=${TMDB_API_KEY}&page=${page}`),
    fetch(`${TMDB_BASE}/tv/top_rated?api_key=${TMDB_API_KEY}&page=${page}`),
  ])
  const [moviesData, tvData] = await Promise.all([
    moviesRes.json(),
    tvRes.json(),
  ])

  const movies = (moviesData.results ?? []).map((r: any) => mapResult(r, "movie"))
  const tv = (tvData.results ?? []).map((r: any) => mapResult(r, "tv"))
  const items = [...movies, ...tv].sort((a, b) => b.rating - a.rating)

  const maxPages = Math.max(moviesData.total_pages ?? 1, tvData.total_pages ?? 1)
  return { items, hasMore: page < maxPages }
}

function dedup(items: TMDBDiscoverItem[], seen: Set<string>): TMDBDiscoverItem[] {
  const out: TMDBDiscoverItem[] = []
  for (const item of items) {
    const key = `${item.mediaType}-${item.id}`
    if (!seen.has(key)) {
      seen.add(key)
      out.push(item)
    }
  }
  return out
}

export function useTMDBDiscover(tab: DiscoverTab) {
  const [items, setItems] = useState<TMDBDiscoverItem[]>([])
  const [loading, setLoading] = useState(true)
  const [loadingMore, setLoadingMore] = useState(false)
  const [hasMore, setHasMore] = useState(true)
  const pageRef = useRef(1)
  const seenIds = useRef(new Set<string>())

  // Reset and fetch page 1 when tab changes
  useEffect(() => {
    let cancelled = false
    pageRef.current = 1
    seenIds.current = new Set()
    setItems([])
    setLoading(true)
    setLoadingMore(false)
    setHasMore(true)

    const fetcher = tab === "trending" ? fetchTrendingPage : fetchTopRatedPage

    fetcher(1)
      .then((result) => {
        if (cancelled) return
        const unique = dedup(result.items, seenIds.current)
        setItems(unique)
        setHasMore(result.hasMore)
      })
      .catch(() => {
        if (!cancelled) setItems([])
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })

    return () => {
      cancelled = true
    }
  }, [tab])

  const loadMore = useCallback(() => {
    // Guard: don't fetch if already loading or nothing left
    if (loadingMore || !hasMore || loading) return

    setLoadingMore(true)
    const nextPage = pageRef.current + 1
    const fetcher = tab === "trending" ? fetchTrendingPage : fetchTopRatedPage

    fetcher(nextPage)
      .then((result) => {
        const unique = dedup(result.items, seenIds.current)
        pageRef.current = nextPage
        setItems((prev) => [...prev, ...unique])
        setHasMore(result.hasMore)
      })
      .catch(() => {
        // silently fail, next intersection will retry
      })
      .finally(() => {
        setLoadingMore(false)
      })
  }, [tab, loadingMore, hasMore, loading])

  return { items, loading, loadingMore, hasMore, loadMore }
}
