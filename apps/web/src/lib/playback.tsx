/**
 * Playback state shared by every page: whether playback is on, what in the
 * library can be played with the signed-in user's progress on it, and what
 * to suggest next. Loaded once, re-read when the library changes and when the
 * user comes back from the player, so Resume buttons and progress stay true.
 *
 * While playback is switched off on the server, `enabled` is false and every
 * playback control stays hidden.
 *
 * It also holds the TV picked to cast to, as on a streaming service: chosen
 * from the Cast button before anything plays, it makes every Play start on
 * that TV. It lasts for the tab's life. And it follows what the user has
 * playing on TVs (`casts`), so a remote that was left can be found again.
 */

import * as React from "react"
import type { PlayableItem, PlaybackCapabilities, PlaybackItemKey, PlaybackLibrary, RendererRecord, RendererStatus } from "@findr/types/playback"
import { fetchCasts, fetchPlaybackCapabilities, fetchPlaybackLibrary } from "./api"
import { useLibrary } from "./library"

interface PlaybackContextValue {
  /** Whether playback is switched on and ffmpeg is installed. */
  enabled: boolean
  /** Whether casting to TVs is offered. */
  casting: boolean
  /** False until the first load has answered. */
  ready: boolean
  library: PlaybackLibrary
  /** The playable item for a movie or episode, if any. */
  itemFor: (key: PlaybackItemKey) => PlayableItem | undefined
  /** Every playable item of one title, in season and episode order. */
  itemsOf: (titleId: string) => PlayableItem[]
  /** Re-reads progress, after watching or marking something. */
  refresh: () => void
  /** The TV that Play sends to, or null to play in this browser. */
  castTarget: RendererRecord | null
  setCastTarget: (renderer: RendererRecord | null) => void
  /** The TVs playing something this user started, loading or stopped ones included. */
  casts: RendererStatus[]
  /** Re-reads `casts`, after a command from outside the remote. */
  refreshCasts: () => void
}

const EMPTY: PlaybackLibrary = { items: [], continueWatching: [], nextUp: [] }

/** How often what plays on TVs is checked while the tab is in view. */
const CASTS_POLL_MS = 5000

/** Whether a TV is still busy with what it was sent, rather than done with it. */
export function castActive(status: RendererStatus): boolean {
  return status.state === "playing" || status.state === "paused" || status.state === "loading"
}

/** Whether two keys name the same movie or episode. */
export function sameItem(a: PlaybackItemKey | null, b: PlaybackItemKey): boolean {
  return a !== null && a.titleId === b.titleId && a.season === b.season && a.episode === b.episode
}

/** A stable string for a movie or episode. */
export function itemKey(key: PlaybackItemKey): string {
  return `${key.titleId}:${key.season ?? "-"}:${key.episode ?? "-"}`
}

/** The watch page's path for a movie or episode. */
export function watchPath(key: PlaybackItemKey): string {
  const params = new URLSearchParams()
  if (key.season !== null) params.set("s", String(key.season))
  if (key.episode !== null) params.set("e", String(key.episode))
  const search = params.toString()
  return `/watch/${key.titleId}${search ? `?${search}` : ""}`
}

/** Where the cast target is kept for the tab's life. */
const CAST_TARGET_KEY = "findr:cast-target"

function readCastTarget(): RendererRecord | null {
  try {
    const stored = sessionStorage.getItem(CAST_TARGET_KEY)
    return stored ? (JSON.parse(stored) as RendererRecord) : null
  } catch {
    return null
  }
}

function writeCastTarget(renderer: RendererRecord | null): void {
  try {
    if (renderer) sessionStorage.setItem(CAST_TARGET_KEY, JSON.stringify(renderer))
    else sessionStorage.removeItem(CAST_TARGET_KEY)
  } catch {
    // A convenience only
  }
}

/**
 * Where to start a movie or episode without asking: its saved position. A
 * finished item keeps none, so one that has a position is being watched
 * again part-way.
 */
export function resumePosition(item: PlayableItem): number {
  return item.positionMs
}

const PlaybackContext = React.createContext<PlaybackContextValue | null>(null)

/** Loads playback state for everything beneath it. Must sit inside `LibraryProvider`. */
export function PlaybackProvider({ children }: { children: React.ReactNode }) {
  const { entries } = useLibrary()
  const [capabilities, setCapabilities] = React.useState<PlaybackCapabilities | null>(null)
  const [library, setLibrary] = React.useState<PlaybackLibrary>(EMPTY)
  const [ready, setReady] = React.useState(false)
  const [castTarget, setCastTargetState] = React.useState<RendererRecord | null>(readCastTarget)
  const [casts, setCasts] = React.useState<RendererStatus[]>([])
  const setCastTarget = React.useCallback((renderer: RendererRecord | null) => {
    writeCastTarget(renderer)
    setCastTargetState(renderer)
  }, [])

  const loadCasts = React.useCallback(async (on: boolean) => {
    setCasts(on ? await fetchCasts().catch(() => []) : [])
  }, [])

  const load = React.useCallback(async () => {
    try {
      const next = await fetchPlaybackCapabilities()
      setCapabilities(next)
      const on = next.enabled && next.ffmpeg
      // Casts load with the rest, so the watch page can rejoin a TV as soon as it is ready
      const [items] = await Promise.all([on ? fetchPlaybackLibrary() : EMPTY, loadCasts(on && next.casting)])
      setLibrary(items)
    } catch {
      // Keep what was last known; playback is never essential to a page
    } finally {
      setReady(true)
    }
  }, [loadCasts])

  // Re-read whenever the library itself changes, such as a download finishing
  const savedCount = React.useMemo(
    () => entries.reduce((sum, entry) => sum + entry.title.downloads.filter((download) => download.status === "completed" || download.status === "partial").length, 0),
    [entries],
  )
  React.useEffect(() => {
    void load()
  }, [load, savedCount])

  // Indexing new files takes a moment after a download finishes; check back once
  React.useEffect(() => {
    if (savedCount === 0) return
    const timer = setTimeout(() => void load(), 15_000)
    return () => clearTimeout(timer)
  }, [load, savedCount])

  const enabled = Boolean(capabilities?.enabled && capabilities.ffmpeg)
  const casting = enabled && Boolean(capabilities?.casting)

  // Follow TVs while casting is on and the tab is in view, catching up as it comes back
  React.useEffect(() => {
    if (!casting) return
    const check = () => {
      if (document.visibilityState === "visible") void loadCasts(true)
    }
    const timer = setInterval(check, CASTS_POLL_MS)
    document.addEventListener("visibilitychange", check)
    return () => {
      clearInterval(timer)
      document.removeEventListener("visibilitychange", check)
    }
  }, [casting, loadCasts])

  const value = React.useMemo<PlaybackContextValue>(() => {
    const byKey = new Map(library.items.map((item) => [itemKey(item), item]))
    const byTitle = new Map<string, PlayableItem[]>()
    for (const item of library.items) {
      const list = byTitle.get(item.titleId) ?? []
      list.push(item)
      byTitle.set(item.titleId, list)
    }
    return {
      enabled,
      casting,
      ready,
      library,
      itemFor: (key) => byKey.get(itemKey(key)),
      itemsOf: (titleId) => byTitle.get(titleId) ?? [],
      refresh: () => void load(),
      castTarget: casting ? castTarget : null,
      setCastTarget,
      casts: casting ? casts : [],
      refreshCasts: () => void loadCasts(casting),
    }
  }, [enabled, casting, ready, library, load, castTarget, setCastTarget, casts, loadCasts])

  return <PlaybackContext.Provider value={value}>{children}</PlaybackContext.Provider>
}

/** Shared playback state. Must be used beneath `PlaybackProvider`. */
export function usePlayback(): PlaybackContextValue {
  const value = React.useContext(PlaybackContext)
  if (!value) throw new Error("usePlayback must be used inside PlaybackProvider")
  return value
}

/** `1:24:07` or `41:12`, for positions and remaining time. */
export function formatClock(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000))
  const hours = Math.floor(total / 3600)
  const minutes = Math.floor((total % 3600) / 60)
  const seconds = total % 60
  const pad = (value: number) => String(value).padStart(2, "0")
  return hours > 0 ? `${hours}:${pad(minutes)}:${pad(seconds)}` : `${minutes}:${pad(seconds)}`
}

/** `1h 12m left` or `8m left`. */
export function formatRemaining(item: PlayableItem): string {
  const minutes = Math.max(1, Math.round((item.durationMs - item.positionMs) / 60_000))
  return minutes >= 60 ? `${Math.floor(minutes / 60)}h ${minutes % 60}m left` : `${minutes}m left`
}
