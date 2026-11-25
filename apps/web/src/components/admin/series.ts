import type { FinishedDownload, SpeedSample } from "@findr/types/admin"
import type { DayOutcome } from "@/components/admin/charts"

/**
 * Turns the Admin page's events into chart series in the viewer's own time
 * zone: one slot per calendar day of the period, and one per hour of the day.
 */

/** Local midnight at the start of the day holding `at`. */
function startOfDay(at: number): number {
  const day = new Date(at)
  day.setHours(0, 0, 0, 0)
  return day.getTime()
}

/** The start of each calendar day in the period, oldest first, ending today. */
export function periodDays(days: number, now = Date.now()): number[] {
  const today = startOfDay(now)
  // Step by calendar day rather than 24 hours, so daylight saving changes don't skip or repeat one
  return Array.from({ length: days }, (_, index) => {
    const day = new Date(today)
    day.setDate(day.getDate() - (days - 1 - index))
    return day.getTime()
  })
}

/** Which slot of `days` an event falls in, or -1 when outside the period. */
function slotOf(days: number[], at: number): number {
  const day = startOfDay(at)
  return days.indexOf(day)
}

/** Finished downloads per day, by outcome. */
export function outcomesByDay(days: number[], finished: FinishedDownload[]): DayOutcome[] {
  const slots = days.map((): DayOutcome => ({ completed: 0, partial: 0, failed: 0, cancelled: 0 }))
  for (const download of finished) {
    const slot = slots[slotOf(days, download.at)]
    if (slot) slot[download.status] += 1
  }
  return slots
}

/** The average of each group, or null for an empty one. */
function averages(groups: number[][]): Array<number | null> {
  return groups.map((group) => (group.length === 0 ? null : group.reduce((sum, value) => sum + value, 0) / group.length))
}

/** Average download speed per day, null on days nothing finished downloading. */
export function speedByDay(days: number[], speeds: SpeedSample[]): Array<number | null> {
  const groups = days.map((): number[] => [])
  for (const sample of speeds) groups[slotOf(days, sample.at)]?.push(sample.bytesPerSecond)
  return averages(groups)
}

/** Average download speed by the local hour downloads finished in. */
export function speedByHour(speeds: SpeedSample[]): Array<number | null> {
  const groups = Array.from({ length: 24 }, (): number[] => [])
  for (const sample of speeds) groups[new Date(sample.at).getHours()]?.push(sample.bytesPerSecond)
  return averages(groups)
}

/** The middle value, or null for none. */
export function median(values: number[]): number | null {
  if (values.length === 0) return null
  const sorted = [...values].sort((a, b) => a - b)
  const middle = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 1 ? (sorted[middle] ?? null) : ((sorted[middle - 1] ?? 0) + (sorted[middle] ?? 0)) / 2
}

/**
 * Counts as whole percentages that sum to 100, largest remainders rounded up,
 * with anything past `limit` parts folded into "Other".
 */
export function shares(parts: Array<{ label: string; count: number }>, limit = 5): Array<{ label: string; share: number }> {
  const total = parts.reduce((sum, part) => sum + part.count, 0)
  if (total === 0) return []
  const kept = parts.length > limit ? [...parts.slice(0, limit - 1), { label: "Other", count: parts.slice(limit - 1).reduce((sum, part) => sum + part.count, 0) }] : parts
  const exact = kept.map((part) => (part.count / total) * 100)
  const rounded = exact.map(Math.floor)
  const order = exact.map((value, index) => [value - Math.floor(value), index] as const).sort((a, b) => b[0] - a[0])
  for (let left = 100 - rounded.reduce((sum, value) => sum + value, 0), at = 0; left > 0; left--, at++) {
    const index = order[at % order.length]?.[1] ?? 0
    rounded[index] = (rounded[index] ?? 0) + 1
  }
  return kept.map((part, index) => ({ label: part.label, share: rounded[index] ?? 0 }))
}

/** A day with its weekday, such as "Tue 3 Mar". */
export function dayName(at: number): string {
  return new Date(at).toLocaleDateString(undefined, { weekday: "short", day: "numeric", month: "short" })
}

/** A short date such as "3 Mar". */
export function shortDate(at: number): string {
  return new Date(at).toLocaleDateString(undefined, { day: "numeric", month: "short" })
}

/** A speed in bytes per second as megabytes per second. */
export function formatSpeed(bytesPerSecond: number): string {
  const mb = bytesPerSecond / (1024 * 1024)
  return `${mb >= 10 ? mb.toFixed(0) : mb.toFixed(1)} MB/s`
}
