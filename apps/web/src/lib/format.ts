/**
 * Display formatting shared across pages: ages, sizes, and episode codes.
 */

/** Renders an epoch-millisecond timestamp as an age, such as "5m ago". */
export function formatRelativeTime(epochMs: number): string {
  const seconds = Math.floor((Date.now() - epochMs) / 1000)
  if (seconds < 60) return "just now"

  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m ago`

  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h ago`

  return `${Math.floor(hours / 24)}d ago`
}

/** Renders a size in megabytes as MB or GB. */
export function formatSize(sizeMB: number): string {
  return sizeMB >= 1024 ? `${(sizeMB / 1024).toFixed(1)} GB` : `${sizeMB} MB`
}

/** `S01E02`, or `S01` when no episode is given. */
export function episodeCode(season: number, episode?: number | null): string {
  const s = `S${String(season).padStart(2, "0")}`
  return episode === undefined || episode === null ? s : `${s}E${String(episode).padStart(2, "0")}`
}

/** A 0–1 fraction as a whole percentage. */
export function formatPercent(fraction: number): string {
  return `${Math.round(fraction * 100)}%`
}
