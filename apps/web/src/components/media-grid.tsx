import * as React from "react"
import { fetchFeatured } from "@/lib/api"
import type { PosterItem } from "@/lib/types"

/**
 * The scrolling poster wall behind the login screen. Columns drift in
 * alternating directions at slightly different speeds, each one doubled so the
 * loop is seamless.
 */

function getColCount(): number {
  if (window.matchMedia("(min-width: 1536px)").matches) return 5
  if (window.matchMedia("(min-width: 1280px)").matches) return 4
  if (window.matchMedia("(min-width: 768px)").matches) return 3
  return 2
}

function useColCount(): number {
  const [cols, setCols] = React.useState(getColCount)

  React.useEffect(() => {
    const queries = [
      window.matchMedia("(min-width: 768px)"),
      window.matchMedia("(min-width: 1280px)"),
      window.matchMedia("(min-width: 1536px)"),
    ]
    const handler = () => setCols(getColCount())
    queries.forEach((query) => query.addEventListener("change", handler))
    return () => queries.forEach((query) => query.removeEventListener("change", handler))
  }, [])

  return cols
}

const DURATIONS = [50, 58, 45, 54, 62]

export function MediaGrid() {
  const colCount = useColCount()
  const [posters, setPosters] = React.useState<PosterItem[]>([])

  React.useEffect(() => {
    let cancelled = false

    fetchFeatured()
      .then((items) => {
        if (!cancelled) setPosters(items)
      })
      .catch(() => {})

    return () => {
      cancelled = true
    }
  }, [])

  if (posters.length === 0) return null

  const columns: PosterItem[][] = Array.from({ length: colCount }, () => [])
  posters.forEach((item, i) => columns[i % colCount]!.push(item))

  return (
    <div className="absolute inset-0 flex gap-2 overflow-hidden px-2">
      <div className="absolute inset-0 z-10 bg-black/60" />
      <div className="absolute inset-x-0 top-0 z-20 h-32 bg-gradient-to-b from-black/80 to-transparent" />
      <div className="absolute inset-x-0 bottom-0 z-20 h-32 bg-gradient-to-t from-black/80 to-transparent" />

      {columns.map((col, colIndex) => {
        const doubled = [...col, ...col]
        const direction = colIndex % 2 === 0 ? "scroll-up" : "scroll-down"

        return (
          <div key={colIndex} className="flex-1 overflow-hidden">
            <div
              className="flex flex-col gap-2"
              style={{
                animation: `${direction} ${DURATIONS[colIndex]}s linear infinite`,
                willChange: "transform",
              }}
            >
              {doubled.map((poster, i) => (
                <img
                  key={`${poster.id}-${i}`}
                  src={`https://image.tmdb.org/t/p/w342${poster.posterPath}`}
                  alt={poster.title}
                  className="w-full rounded-sm object-cover"
                  draggable={false}
                />
              ))}
            </div>
          </div>
        )
      })}
    </div>
  )
}
