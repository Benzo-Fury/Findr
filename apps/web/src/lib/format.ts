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

/** Renders a runtime in minutes as `48m` or `2h 7m`. */
export function formatRuntime(minutes: number): string {
  if (minutes < 60) return `${minutes}m`
  const hours = Math.floor(minutes / 60)
  const rest = minutes % 60
  return rest ? `${hours}h ${rest}m` : `${hours}h`
}

/** `1 title` or `3 titles`. */
export function plural(count: number, one: string, many = `${one}s`): string {
  return `${count.toLocaleString()} ${count === 1 ? one : many}`
}

/**
 * The calendar bucket an activity falls into, for grouping a history:
 * Today, Yesterday, This week, then month names.
 */
export function dayGroup(epochMs: number, now = Date.now()): string {
  const startOfToday = new Date(now)
  startOfToday.setHours(0, 0, 0, 0)
  const dayMs = 24 * 60 * 60 * 1000
  const today = startOfToday.getTime()

  if (epochMs >= today) return "Today"
  if (epochMs >= today - dayMs) return "Yesterday"
  if (epochMs >= today - 6 * dayMs) return "This week"

  const date = new Date(epochMs)
  const sameYear = date.getFullYear() === startOfToday.getFullYear()
  return date.toLocaleDateString(undefined, sameYear ? { month: "long" } : { month: "long", year: "numeric" })
}

/** Renders a byte count as MB, GB or TB, with more precision for small values of each. */
export function formatBytes(bytes: number): string {
  const units = ["B", "KB", "MB", "GB", "TB", "PB"]
  let value = Math.max(bytes, 0)
  let unit = 0
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024
    unit++
  }
  const digits = unit === 0 ? 0 : value >= 100 ? 0 : value >= 10 ? 1 : 2
  return `${value.toFixed(digits)} ${units[unit]}`
}

/** Renders milliseconds as the two largest units, seconds only under ten minutes: `45s`, `8m 5s`, `12m`, `3h 20m`, `2d 4h`. */
export function formatDuration(ms: number): string {
  const seconds = Math.round(ms / 1000)
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 10) return seconds % 60 ? `${minutes}m ${seconds % 60}s` : `${minutes}m`
  if (minutes < 60) return `${minutes}m`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return minutes % 60 ? `${hours}h ${minutes % 60}m` : `${hours}h`
  const days = Math.floor(hours / 24)
  return hours % 24 ? `${days}d ${hours % 24}h` : `${days}d`
}
