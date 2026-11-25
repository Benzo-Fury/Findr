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

/** How each kind of TV is named when two share a name, as a Google TV listed by both Cast and DLNA is. */
const KIND_LABELS: Record<RendererRecord["kind"], string> = { googlecast: "Google Cast", dlna: "DLNA" }

/**
 * What a TV list shows under a TV's name: nothing, since the name is what
 * people know a TV by, unless another TV in the list shares it, when how
 * each is reached (Google Cast or DLNA) and where tell them apart.
 */
export function rendererDetail(renderer: RendererRecord, listed: RendererRecord[]): string | null {
  const namesakes = listed.filter((other) => other.id !== renderer.id && other.name === renderer.name)
  if (namesakes.length === 0) return null
  const parts: string[] = []
  if (namesakes.some((other) => other.kind !== renderer.kind)) parts.push(KIND_LABELS[renderer.kind])
  if (namesakes.some((other) => other.place !== renderer.place) || parts.length === 0) parts.push(renderer.place ? `via ${renderer.place}` : "on the server's network")
  const detail = parts.join(", ")
  return detail.charAt(0).toUpperCase() + detail.slice(1)
}

/** Every TV on the server's network and its cast bridges', of any kind, searched for when the caller mounts. */
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
