import * as React from "react"
import type { RendererRecord } from "@findr/types/playback"
import { fetchRenderers } from "./api"

interface RenderersState {
  /** The TVs found, or null before the first answer. */
  renderers: RendererRecord[] | null
  error: string | null
  searching: boolean
  /** Asks again; `refresh` makes the server search the network afresh. */
  search: (refresh: boolean) => Promise<void>
}

/**
 * What a TV list shows under a TV's name: the bridge it is reached through,
 * then its make and model; null when there is nothing to say.
 */
export function rendererDetail(renderer: RendererRecord): string | null {
  const model = [renderer.manufacturer, renderer.model].filter(Boolean).join(" ")
  return [renderer.place ? `via ${renderer.place}` : null, model || null].filter(Boolean).join(", ") || null
}

/** DLNA TVs on the server's network and its cast bridges', searched for when the caller mounts. */
export function useRenderers(): RenderersState {
  const [renderers, setRenderers] = React.useState<RendererRecord[] | null>(null)
  const [error, setError] = React.useState<string | null>(null)
  const [searching, setSearching] = React.useState(false)

  const search = React.useCallback(async (refresh: boolean) => {
    setSearching(true)
    setError(null)
    try {
      setRenderers(await fetchRenderers(refresh))
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Could not search for TVs")
    } finally {
      setSearching(false)
    }
  }, [])
  React.useEffect(() => void search(false), [search])

  return { renderers, error, searching, search }
}
