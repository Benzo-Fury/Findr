/**
 * Shared data-loading hooks: paging through a TMDB list, driving that paging
 * from a scroll sentinel, and resolving IMDb IDs to titles and artwork.
 */

import * as React from "react"
import type { PosterItem, TMDBMeta } from "./types"
import { fetchList, findByImdbId, type ListSource } from "./api"

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

/**
 * Resolves IMDb IDs to titles and artwork.
 *
 * Jobs and indexes store only an IMDb ID, so anything listing them needs this
 * to render something a person recognises. Results are memoised per ID and
 * in-flight lookups are de-duplicated.
 */
export function useTMDBMeta() {
  const [meta, setMeta] = React.useState<Record<string, TMDBMeta>>({})
  const [loadingIds, setLoadingIds] = React.useState<Set<string>>(new Set())
  const pending = React.useRef(new Set<string>())

  const fetchMeta = React.useCallback(
    (imdbId: string) => {
      if (meta[imdbId] || pending.current.has(imdbId)) return

      pending.current.add(imdbId)
      setLoadingIds((prev) => new Set(prev).add(imdbId))

      findByImdbId(imdbId)
        .then((data) => {
          const movie = (data.movie_results as Record<string, unknown>[])?.[0]
          const tv = (data.tv_results as Record<string, unknown>[])?.[0]
          const item = movie || tv
          if (!item) return

          const date = (item.release_date || item.first_air_date || "") as string

          setMeta((prev) => ({
            ...prev,
            [imdbId]: {
              tmdbId: item.id as number,
              title: (item.title || item.name) as string,
              year: date.slice(0, 4),
              posterPath: (item.poster_path as string | null) ?? null,
              overview: (item.overview as string) ?? "",
              mediaType: movie ? "movie" : "tv",
            },
          }))
        })
        .catch(() => {})
        .finally(() => {
          setLoadingIds((prev) => {
            const next = new Set(prev)
            next.delete(imdbId)
            return next
          })
        })
    },
    [meta],
  )

  return { meta, loadingIds, fetchMeta }
}
