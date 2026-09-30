/**
 * Shared data-loading hooks: paging through a TMDB list, driving that paging
 * from a scroll sentinel, resolving TMDB ids to titles and artwork, and
 * polling while something is in progress.
 */

import * as React from "react"
import type { MediaType, PosterItem, TMDBMeta } from "./types"
import { fetchList, fetchTMDBDetails, type ListSource } from "./api"

/**
 * Pages through one of the API's named TMDB lists.
 *
 * Passing `initialItems` seeds the first page from data the caller already
 * has — the discover feed's rows, for instance — so the grid renders without
 * repeating a request the page has already made.
 */
export function useTMDBList(
  source: ListSource,
  mediaType: string,
  initialItems?: PosterItem[],
) {
  const [items, setItems] = React.useState<PosterItem[]>([])
  const [loading, setLoading] = React.useState(true)
  const [loadingMore, setLoadingMore] = React.useState(false)
  const [hasMore, setHasMore] = React.useState(true)
  const pageRef = React.useRef(1)
  const loadingMoreRef = React.useRef(false)
  const hasMoreRef = React.useRef(true)

  React.useEffect(() => {
    setHasMore(true)
    setLoadingMore(false)
    hasMoreRef.current = true
    loadingMoreRef.current = false
    pageRef.current = 1

    if (initialItems) {
      setItems(initialItems)
      setLoading(false)
      return
    }

    setItems([])
    setLoading(true)

    fetchList(source, 1, mediaType)
      .then((data) => {
        setItems(data.results)
        const more = data.page < data.totalPages
        setHasMore(more)
        hasMoreRef.current = more
        setLoading(false)
      })
      .catch(() => setLoading(false))
  }, [source, mediaType, initialItems])

  const loadMore = React.useCallback(() => {
    if (loadingMoreRef.current || !hasMoreRef.current) return
    loadingMoreRef.current = true
    setLoadingMore(true)

    const nextPage = pageRef.current + 1

    fetchList(source, nextPage, mediaType)
      .then((data) => {
        pageRef.current = nextPage

        // Merged movie/TV pages can repeat a title across page boundaries
        setItems((prev) => {
          const seen = new Set(prev.map((item) => `${item.mediaType}-${item.id}`))
          const unique = data.results.filter(
            (item) => !seen.has(`${item.mediaType}-${item.id}`),
          )
          return [...prev, ...unique]
        })

        const more = data.page < data.totalPages
        setHasMore(more)
        hasMoreRef.current = more
        loadingMoreRef.current = false
        setLoadingMore(false)
      })
      .catch(() => {
        loadingMoreRef.current = false
        setLoadingMore(false)
      })
  }, [source, mediaType])

  return { items, loading, loadingMore, hasMore, loadMore }
}

/**
 * Calls `loadMore` whenever the returned ref's element scrolls into view.
 *
 * Returns a callback ref to attach to a sentinel element placed after the
 * content being paged.
 */
export function useInfiniteScroll(
  loadMore: () => void,
  hasMore: boolean,
  isLoading: boolean,
) {
  const nodeRef = React.useRef<HTMLDivElement | null>(null)
  const observerRef = React.useRef<IntersectionObserver | null>(null)
  const callbackRef = React.useRef(loadMore)
  callbackRef.current = loadMore
  const hasMoreRef = React.useRef(hasMore)
  hasMoreRef.current = hasMore
  const isLoadingRef = React.useRef(isLoading)
  isLoadingRef.current = isLoading

  const attachObserver = React.useCallback((node: HTMLDivElement | null) => {
    if (observerRef.current) {
      observerRef.current.disconnect()
      observerRef.current = null
    }

    nodeRef.current = node
    if (!node) return

    observerRef.current = new IntersectionObserver(
      (entries) => {
        if (entries[0]?.isIntersecting && hasMoreRef.current && !isLoadingRef.current) {
          callbackRef.current()
        }
      },
      { rootMargin: "800px" },
    )
    observerRef.current.observe(node)
  }, [])

  // Re-attach once loading finishes so the observer re-evaluates whether the
  // sentinel is still in view — it only fires on observe.
  React.useEffect(() => {
    if (!isLoading && hasMore && nodeRef.current) {
      attachObserver(nodeRef.current)
    }
  }, [isLoading, hasMore, attachObserver])

  return attachObserver
}

/** Cache key for a TMDB identity; movie and show ids overlap. */
export function tmdbKey(mediaType: MediaType, tmdbId: number): string {
  return `${mediaType}-${tmdbId}`
}

/**
 * Resolves TMDB ids to titles and artwork.
 *
 * Downloads and titles store only TMDB identity, so anything listing them
 * needs this to render something a person recognises. Results are memoised
 * per title and in-flight lookups are de-duplicated. Look results up with
 * `tmdbKey`.
 */
export function useTMDBMeta() {
  const [meta, setMeta] = React.useState<Record<string, TMDBMeta>>({})
  const requested = React.useRef(new Set<string>())

  const fetchMeta = React.useCallback((mediaType: MediaType, tmdbId: number) => {
    const key = tmdbKey(mediaType, tmdbId)
    if (requested.current.has(key)) return
    requested.current.add(key)

    fetchTMDBDetails(mediaType, tmdbId)
      .then((data) => {
        const date = String(data.release_date ?? data.first_air_date ?? "")
        setMeta((prev) => ({
          ...prev,
          [key]: {
            title: String(data.title ?? data.name ?? ""),
            year: date.slice(0, 4),
            posterPath: typeof data.poster_path === "string" ? data.poster_path : null,
          },
        }))
      })
      .catch(() => {
        // Let a later render try again
        requested.current.delete(key)
      })
  }, [])

  return { meta, fetchMeta }
}

/**
 * Calls `load` every `intervalMs` while `active` is true. The latest `load` is
 * always used, so callers need not memoise it.
 */
export function usePolling(load: () => void, active: boolean, intervalMs: number) {
  const latest = React.useRef(load)
  latest.current = load

  React.useEffect(() => {
    if (!active) return
    const timer = setInterval(() => latest.current(), intervalMs)
    return () => clearInterval(timer)
  }, [active, intervalMs])
}
