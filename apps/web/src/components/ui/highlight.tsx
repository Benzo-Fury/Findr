import type * as React from "react"
import { matchRanges } from "@/lib/search"

interface HighlightProps {
  text: string
  /** Normalised query words, from `queryWords`. */
  words: string[]
}

/** Text with every matched query word marked in the highlighter. */
export function Highlight({ text, words }: HighlightProps) {
  const ranges = matchRanges(text, words)
  if (ranges.length === 0) return <>{text}</>

  const parts: React.ReactNode[] = []
  let cursor = 0
  for (const [start, end] of ranges) {
    if (start > cursor) parts.push(text.slice(cursor, start))
    parts.push(
      <mark key={start} className="mark">
        {text.slice(start, end)}
      </mark>,
    )
    cursor = end
  }
  if (cursor < text.length) parts.push(text.slice(cursor))

  return <>{parts}</>
}
