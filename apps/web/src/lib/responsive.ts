/**
 * Responsive helpers for behaviour that CSS alone cannot switch: which sheet
 * a title opens in, whether hover effects run, how many grid columns exist.
 */

import * as React from "react"

/** Breakpoints in pixels, matching the Tailwind theme. */
export const BREAKPOINTS = { sm: 640, md: 768, lg: 1024, xl: 1280, "2xl": 1536 } as const

/** Whether a media query matches, kept current as it changes. */
export function useMediaQuery(query: string): boolean {
  const subscribe = React.useCallback(
    (onChange: () => void) => {
      const list = window.matchMedia(query)
      list.addEventListener("change", onChange)
      return () => list.removeEventListener("change", onChange)
    },
    [query],
  )
  return React.useSyncExternalStore(subscribe, () => window.matchMedia(query).matches)
}

/** True on phones, where panels become bottom sheets and navigation moves to the thumb. */
export function useIsPhone(): boolean {
  return useMediaQuery(`(max-width: ${BREAKPOINTS.md - 1}px)`)
}

/** True when the primary pointer can hover precisely, which gates hover-only effects. */
export function useFinePointer(): boolean {
  return useMediaQuery("(hover: hover) and (pointer: fine)")
}

/** The width of an element, kept current as it resizes. */
export function useElementWidth<T extends HTMLElement>(): [React.RefCallback<T>, number] {
  const [width, setWidth] = React.useState(0)
  const observer = React.useRef<ResizeObserver | null>(null)

  const ref = React.useCallback((node: T | null) => {
    observer.current?.disconnect()
    if (!node) return
    observer.current = new ResizeObserver(([entry]) => {
      if (entry) setWidth(entry.contentRect.width)
    })
    observer.current.observe(node)
  }, [])

  return [ref, width]
}
