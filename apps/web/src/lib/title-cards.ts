/**
 * The library's TMDB facts, kept across visits.
 *
 * Titles store only their TMDB identity, so showing or searching a library
 * means resolving every title's name and artwork. The store does that in
 * batches through the API and keeps the result in browser storage, so a
 * returning visit can search a large library at once and only refreshes what
 * has gone stale, in the background.
 */

import * as React from "react"
import { fetchTitleCards, TITLE_CARD_BATCH } from "./api"
import type { MediaType, TitleCard } from "./types"

/** Where cards are kept between visits. Bump the version when the card shape changes. */
const STORAGE_KEY = "findr:title-cards:v1"

/** Cards older than this are still shown, then refreshed. */
const STALE_AFTER_MS = 7 * 24 * 60 * 60 * 1000

/** How long writes are gathered before storage is updated. */
const PERSIST_DELAY_MS = 750

/** A TMDB identity as the store keys it, such as `movie:603`. */
export function cardKey(mediaType: MediaType, id: number): string {
  return `${mediaType}:${id}`
}

/** A stored card and when it was fetched. */
interface StoredCard {
  card: TitleCard
  savedAt: number
}

/**
 * Holds every resolved card, notifies subscribers when cards arrive, and
 * de-duplicates lookups so many components can ask for the same title.
 */
class TitleCardStore {
  private cards = new Map<string, StoredCard>()
  private inFlight = new Set<string>()
  private listeners = new Set<() => void>()
  private version = 0
  private persistTimer: ReturnType<typeof setTimeout> | undefined

  constructor() {
    this.restore()
  }

  /** Subscribes to card arrivals; returns the unsubscribe function. */
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  /** A number that changes whenever any card does, for `useSyncExternalStore`. */
  snapshot = (): number => this.version

  /** The card for a key, if it has been resolved. */
  get(key: string): TitleCard | undefined {
    return this.cards.get(key)?.card
  }

  /**
   * Resolves every key that is missing or stale. Missing ones are fetched
   * first so a fresh library fills in before anything is refreshed.
   */
  async resolve(keys: string[]): Promise<void> {
    const now = Date.now()
    const missing: string[] = []
    const stale: string[] = []

    for (const key of new Set(keys)) {
      if (this.inFlight.has(key)) continue
      const stored = this.cards.get(key)
      if (!stored) missing.push(key)
      else if (now - stored.savedAt > STALE_AFTER_MS) stale.push(key)
    }

    // Batches run one after another so a huge library cannot flood the API
    for (const batch of this.chunk([...missing, ...stale])) {
      await this.fetchBatch(batch)
    }
  }

  /** Fetches one batch and stores what came back. Failures are retried on a later resolve. */
  private async fetchBatch(keys: string[]): Promise<void> {
    for (const key of keys) this.inFlight.add(key)

    try {
      const cards = await fetchTitleCards(keys.map((key) => this.parse(key)))
      const savedAt = Date.now()
      for (const card of cards) this.cards.set(cardKey(card.mediaType, card.id), { card, savedAt })
      this.changed()
    } catch {
      // Leave the keys unresolved; the next resolve tries again
    } finally {
      for (const key of keys) this.inFlight.delete(key)
    }
  }

  /** Bumps the version, tells subscribers, and schedules a write to storage. */
  private changed(): void {
    this.version++
    for (const listener of this.listeners) listener()

    clearTimeout(this.persistTimer)
    this.persistTimer = setTimeout(() => this.persist(), PERSIST_DELAY_MS)
  }

  /** Loads cards saved by an earlier visit. Storage can be missing or blocked. */
  private restore(): void {
    try {
      const raw = localStorage.getItem(STORAGE_KEY)
      if (!raw) return
      const entries = JSON.parse(raw) as [string, StoredCard][]
      this.cards = new Map(entries)
    } catch {
      this.cards = new Map()
    }
  }

  /** Saves every card. Quota or privacy errors simply leave storage as it was. */
  private persist(): void {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify([...this.cards]))
    } catch {
      // Storage is a convenience; the cards still live in memory
    }
  }

  /** Splits keys into request-sized batches. */
  private chunk(keys: string[]): string[][] {
    const batches: string[][] = []
    for (let index = 0; index < keys.length; index += TITLE_CARD_BATCH) {
      batches.push(keys.slice(index, index + TITLE_CARD_BATCH))
    }
    return batches
  }

  /** Reads a key back into its parts. */
  private parse(key: string): { mediaType: MediaType; id: number } {
    const [mediaType, id] = key.split(":")
    return { mediaType: mediaType === "tv" ? "tv" : "movie", id: Number(id) }
  }
}

/** The one store the app shares. */
export const titleCards = new TitleCardStore()

/**
 * Re-renders whenever any card arrives and returns a lookup into the store.
 * Pass keys to have them resolved; leave them out to only read.
 */
export function useTitleCards(keys?: string[]): (key: string) => TitleCard | undefined {
  const version = React.useSyncExternalStore(titleCards.subscribe, titleCards.snapshot)
  const signature = keys?.join(",") ?? ""

  React.useEffect(() => {
    if (signature) titleCards.resolve(signature.split(","))
  }, [signature])

  // A new function per version, so memoised consumers notice new cards
  return React.useCallback((key: string) => titleCards.get(key), [version])
}
