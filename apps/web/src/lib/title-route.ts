/**
 * The open title lives in the URL (`?t=movie:603`) on every page, so a title
 * can be linked to, the back button closes it, and opening a recommendation
 * from inside the sheet is just another navigation.
 */

import * as React from "react"
import { useSearchParams } from "react-router-dom"
import type { MediaType } from "./types"

/** The search parameter holding the open title. */
const PARAM = "t"

/** A title reference parsed from the URL. */
export interface TitleRef {
  mediaType: MediaType
  id: number
}

/** Reads `movie:603` back into a reference, or null for anything else. */
function parse(value: string | null): TitleRef | null {
  const match = value?.match(/^(movie|tv):(\d+)$/)
  if (!match) return null
  return { mediaType: match[1] as MediaType, id: Number(match[2]) }
}

/** The open title, and functions to open another or close it. */
export function useTitleRoute() {
  const [params, setParams] = useSearchParams()
  const open = parse(params.get(PARAM))

  const openTitle = React.useCallback(
    (ref: TitleRef) => {
      setParams((current) => {
        const next = new URLSearchParams(current)
        next.set(PARAM, `${ref.mediaType}:${ref.id}`)
        return next
      })
    },
    [setParams],
  )

  const closeTitle = React.useCallback(() => {
    setParams((current) => {
      const next = new URLSearchParams(current)
      next.delete(PARAM)
      return next
    })
  }, [setParams])

  return { open, openTitle, closeTitle }
}

/* -------------------------------------------------------------------------- */
/* Shared poster                                                              */
/* -------------------------------------------------------------------------- */

/**
 * The same title can appear on a page more than once (two discover shelves,
 * say), so each poster's shared-element id is scoped: `scope|movie:603`. The
 * card that was clicked records its id here and the sheet borrows it, so the
 * poster flies from the card the user actually touched.
 */
let posterOrigin: string | null = null

/** A poster's shared-element id within a scope such as a shelf or grid. */
export function posterLayoutId(scope: string, key: string): string {
  return `${scope}|${key}`
}

/** Records the poster a title is being opened from. */
export function rememberPosterOrigin(layoutId: string): void {
  posterOrigin = layoutId
}

/** The recorded origin when it belongs to this title. */
export function posterOriginFor(key: string): string | undefined {
  return posterOrigin?.endsWith(`|${key}`) ? posterOrigin : undefined
}
