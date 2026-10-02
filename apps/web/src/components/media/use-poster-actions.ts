import * as React from "react"
import { DOWNLOAD_STATUS, isActive, type StatusStyle } from "@/lib/download-status"
import { useLibrary } from "@/lib/library"
import { cardKey } from "@/lib/title-cards"
import { posterLayoutId, rememberPosterOrigin, useTitleRoute } from "@/lib/title-route"
import type { PosterItem } from "@/lib/types"

/** What a browsing surface shows about a title Findr already knows. */
export interface KnownState {
  status: StatusStyle
  progress?: number | null
}

/**
 * Opening titles from a browsing surface, and what the library already says
 * about them, so every shelf and grid answers "do I have this?" the same way.
 */
export function usePosterActions(scope: string) {
  const { byKey } = useLibrary()
  const { openTitle } = useTitleRoute()

  const layoutIdFor = React.useCallback((item: PosterItem) => posterLayoutId(scope, cardKey(item.mediaType, item.id)), [scope])

  const open = React.useCallback(
    (item: PosterItem) => {
      rememberPosterOrigin(layoutIdFor(item))
      openTitle({ mediaType: item.mediaType, id: item.id })
    },
    [layoutIdFor, openTitle],
  )

  const known = React.useCallback(
    (item: PosterItem): KnownState | undefined => {
      const entry = byKey.get(cardKey(item.mediaType, item.id))
      if (!entry?.latest) return undefined
      const running = entry.title.downloads.find((download) => isActive(download.status))
      if (running) return { status: DOWNLOAD_STATUS[running.status], progress: running.activeAttempt?.progress ?? null }
      return { status: DOWNLOAD_STATUS[entry.latest.status] }
    },
    [byKey],
  )

  return { open, known, layoutIdFor }
}
