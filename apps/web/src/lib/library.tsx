/**
 * What Findr holds, shared by every page: the whole library of requested
 * titles with their TMDB cards, and the downloads that are running right now.
 *
 * The library is loaded in full because it is searched and filtered on the
 * client, where that is instant. Active downloads are polled on their own,
 * cheaply, and the library is re-read whenever one of them finishes, so
 * statuses stay current without re-reading a large library every few seconds.
 */

import * as React from "react"
import type { DownloadSummary, TitleSummary } from "@findr/types/downloads"
import { fetchAllTitles, fetchDownloads } from "./api"
import { cardKey, useTitleCards } from "./title-cards"
import type { TitleCard } from "./types"

/** How often active downloads are re-read while something is running. */
const ACTIVE_POLL_MS = 3000

/** How often to check for new activity while nothing is running. */
const IDLE_POLL_MS = 20000

/** One title in the library, with its card once TMDB has answered. */
export interface LibraryEntry {
  /** The title's `cardKey`. */
  key: string
  title: TitleSummary
  card: TitleCard | undefined
  /** The title's most recent download. */
  latest: DownloadSummary | null
}

interface LibraryContextValue {
  entries: LibraryEntry[]
  /** Entries by `cardKey`, for "is this in my library?" lookups. */
  byKey: Map<string, LibraryEntry>
  /** True until the first load finishes. */
  loading: boolean
  error: string | null
  /** Every download that has not finished, newest activity first. */
  active: DownloadSummary[]
  /** Re-reads the library and active downloads, after the user changed something. */
  refresh: () => void
}

const LibraryContext = React.createContext<LibraryContextValue | null>(null)

/** Loads the library and keeps active downloads polled for everything beneath it. */
export function LibraryProvider({ children }: { children: React.ReactNode }) {
  const [titles, setTitles] = React.useState<TitleSummary[]>([])
  const [loading, setLoading] = React.useState(true)
  const [error, setError] = React.useState<string | null>(null)
  const [active, setActive] = React.useState<DownloadSummary[]>([])
  const activeIds = React.useRef(new Set<string>())

  // Read every title; the cards resolve separately below
  const loadTitles = React.useCallback(async () => {
    try {
      setTitles(await fetchAllTitles())
      setError(null)
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not load the library")
    } finally {
      setLoading(false)
    }
  }, [])

  // Read active downloads, re-reading the library when one has finished
  const loadActive = React.useCallback(async () => {
    try {
      const page = await fetchDownloads({ state: "active", pageSize: 100 })
      const ids = new Set(page.items.map((item) => item.id))
      const finishedSome = [...activeIds.current].some((id) => !ids.has(id))
      const startedSome = page.items.some((item) => !activeIds.current.has(item.id))

      activeIds.current = ids
      setActive(page.items)
      if (finishedSome || startedSome) loadTitles()
    } catch {
      // Keep showing the last known activity
    }
  }, [loadTitles])

  React.useEffect(() => {
    loadTitles()
    loadActive()
  }, [loadTitles, loadActive])

  // Poll quickly while something runs, slowly otherwise, and not at all while hidden
  const anyActive = active.length > 0
  React.useEffect(() => {
    const interval = anyActive ? ACTIVE_POLL_MS : IDLE_POLL_MS
    const timer = setInterval(() => {
      if (document.visibilityState === "visible") loadActive()
    }, interval)

    const onVisible = () => {
      if (document.visibilityState === "visible") loadActive()
    }
    document.addEventListener("visibilitychange", onVisible)

    return () => {
      clearInterval(timer)
      document.removeEventListener("visibilitychange", onVisible)
    }
  }, [anyActive, loadActive])

  const keys = React.useMemo(() => titles.map((title) => cardKey(title.mediaType, title.tmdbId)), [titles])
  const cardFor = useTitleCards(keys)

  // Live progress from the active poll replaces the library's older copy
  const entries = React.useMemo<LibraryEntry[]>(() => {
    const live = new Map(active.map((download) => [download.id, download]))

    return titles.map((title, index) => {
      const key = keys[index] as string
      const touched = title.downloads.some((download) => live.has(download.id))
      const current = touched
        ? { ...title, downloads: title.downloads.map((download) => live.get(download.id) ?? download) }
        : title
      return { key, title: current, card: cardFor(key), latest: current.downloads[0] ?? null }
    })
  }, [titles, keys, cardFor, active])

  const byKey = React.useMemo(() => new Map(entries.map((entry) => [entry.key, entry])), [entries])

  const refresh = React.useCallback(() => {
    loadTitles()
    loadActive()
  }, [loadTitles, loadActive])

  const value = React.useMemo(
    () => ({ entries, byKey, loading, error, active, refresh }),
    [entries, byKey, loading, error, active, refresh],
  )

  return <LibraryContext.Provider value={value}>{children}</LibraryContext.Provider>
}

/** The shared library. Must be used beneath `LibraryProvider`. */
export function useLibrary(): LibraryContextValue {
  const value = React.useContext(LibraryContext)
  if (!value) throw new Error("useLibrary must be used inside LibraryProvider")
  return value
}
