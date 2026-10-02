/**
 * Text matching for the instant searches (library, palette, settings). Case
 * and accents are ignored, every word of the query must appear, and the
 * matched ranges are returned so results can highlight what matched.
 */

/** Lower-cases and strips accents so "Amélie" matches "amelie". */
export function normalize(text: string): string {
  return text.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase()
}

/** The words of a query, normalised. */
export function queryWords(query: string): string[] {
  return normalize(query).split(/\s+/).filter(Boolean)
}

/** Whether every query word appears somewhere in the haystack. */
export function matchesAll(haystack: string, words: string[]): boolean {
  if (words.length === 0) return true
  const normal = normalize(haystack)
  return words.every((word) => normal.includes(word))
}

/** Character ranges in `text` covered by any query word, merged and ordered. */
export function matchRanges(text: string, words: string[]): [number, number][] {
  if (words.length === 0) return []
  const normal = normalize(text)
  const ranges: [number, number][] = []

  for (const word of words) {
    let from = normal.indexOf(word)
    while (from !== -1) {
      ranges.push([from, from + word.length])
      from = normal.indexOf(word, from + word.length)
    }
  }

  // Merge overlaps so each character is highlighted once
  ranges.sort((a, b) => a[0] - b[0])
  const merged: [number, number][] = []
  for (const range of ranges) {
    const last = merged[merged.length - 1]
    if (last && range[0] <= last[1]) last[1] = Math.max(last[1], range[1])
    else merged.push([...range])
  }
  return merged
}
