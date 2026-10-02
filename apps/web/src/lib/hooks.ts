/**
 * Shared data-loading hooks: paging through any poster source, driving that
 * paging from a scroll sentinel, and polling while something is in progress.
 */

import * as React from "react"
import type { PosterItem, PosterPage } from "./types"

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

/**
 * Pages through any paged poster source, restarting whenever `key` changes.
 * Repeats across pages are dropped (merged movie and TV pages can overlap).
 * Each loaded page is remembered as a batch, so a grid can reveal it as one.
 */
export function usePagedPosters(key: string, load: (page: number, signal: AbortSignal) => Promise<PosterPage>) {
  const [items, setItems] = React.useState<PosterItem[]>([])
  const [loading, setLoading] = React.useState(true)
  const [loadingMore, setLoadingMore] = React.useState(false)
  const [error, setError] = React.useState(false)
  const [hasMore, setHasMore] = React.useState(false)
  const pageRef = React.useRef(1)
  const busy = React.useRef(false)
  const loadRef = React.useRef(load)
  loadRef.current = load
  const controller = React.useRef<AbortController | null>(null)

  // A new key starts over from the first page
  React.useEffect(() => {
    controller.current?.abort()
    const current = new AbortController()
    controller.current = current
    pageRef.current = 1
    busy.current = true
    setItems([])
    setLoading(true)
    setError(false)

    loadRef
      .current(1, current.signal)
      .then((page) => {
        setItems(page.results)
        setHasMore(page.page < page.totalPages)
      })
      .catch(() => {
        if (!current.signal.aborted) setError(true)
      })
      .finally(() => {
        if (current.signal.aborted) return
        busy.current = false
        setLoading(false)
      })

    return () => current.abort()
  }, [key])

  const loadMore = React.useCallback(() => {
    if (busy.current || !controller.current) return
    const signal = controller.current.signal
    busy.current = true
    setLoadingMore(true)
    const next = pageRef.current + 1

    loadRef
      .current(next, signal)
      .then((page) => {
        pageRef.current = next
        setItems((previous) => {
          const seen = new Set(previous.map((item) => `${item.mediaType}-${item.id}`))
          return [...previous, ...page.results.filter((item) => !seen.has(`${item.mediaType}-${item.id}`))]
        })
        setHasMore(page.page < page.totalPages)
      })
      .catch(() => {})
      .finally(() => {
        if (signal.aborted) return
        busy.current = false
        setLoadingMore(false)
      })
  }, [])

  return { items, loading, loadingMore, error, hasMore, loadMore }
}
