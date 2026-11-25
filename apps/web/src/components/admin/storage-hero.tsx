import * as React from "react"
import { motion } from "motion/react"
import type { AdminStorage, DiskParts, DiskUsage } from "@findr/types/admin"
import { formatBytes } from "@/lib/format"
import { EASE_OUT } from "@/lib/motion"
import { cn } from "@/lib/utils"
import { Figure } from "@/components/admin/charts"

/** Findr's share of a disk, in the order the bar draws them, and how each looks. */
const PARTS: Array<{ key: keyof DiskParts; label: string; tone: string }> = [
  { key: "movies", label: "Movies", tone: "bg-ink" },
  { key: "tv", label: "TV", tone: "bg-ink-2" },
  { key: "downloads", label: "Downloading", tone: "bg-signal" },
  { key: "playback", label: "Playback scratch", tone: "bg-ink-3" },
]

const FREE_PATTERN = "repeating-linear-gradient(-45deg, var(--color-surface) 0 7px, var(--color-sunken) 7px 9px)"

/** A size as a number and its unit apart, so the number can count up in display type. */
function splitSize(bytes: number): { value: number; unit: string; digits: number } {
  const tb = 1024 ** 4
  if (bytes >= tb) return { value: bytes / tb, unit: "TB", digits: 2 }
  const gb = 1024 ** 3
  return { value: bytes / gb, unit: "GB", digits: bytes >= 100 * gb ? 0 : 1 }
}

/** The disk's parts with what isn't Findr's as "Other files". */
function segments(disk: DiskUsage) {
  const used = disk.totalBytes - disk.freeBytes
  const findr = PARTS.reduce((sum, part) => sum + disk.parts[part.key], 0)
  return [
    ...PARTS.map((part) => ({ ...part, bytes: disk.parts[part.key] })),
    { key: "other", label: "Other files", tone: "bg-[color-mix(in_srgb,var(--color-ink-3)_40%,var(--color-sunken))]", bytes: Math.max(used - findr, 0) },
  ].filter((segment) => segment.bytes > 0)
}

/** How the drive is filling, in a sentence. */
function forecast(disk: DiskUsage, weeklyGrowthBytes: number | null): React.ReactNode {
  if (weeklyGrowthBytes === null) return "No library files are indexed yet, so there's no rate to go on."
  if (weeklyGrowthBytes < 1024 ** 3 / 10) return "Nothing much was added in the last four weeks."
  const weeks = disk.freeBytes / weeklyGrowthBytes
  const when = weeks > 104 ? "more than two years" : weeks >= 8 ? `${Math.round(weeks / 4.35)} months` : `${Math.max(1, Math.floor(weeks))} weeks`
  return (
    <>
      At about {formatBytes(weeklyGrowthBytes)} a week, it fills in <span className="mark font-semibold text-ink">{when}</span>.
    </>
  )
}

/** Storage leads the page: the library disk's free space in display type over the disk drawn as one bar. */
export function StorageHero({ storage }: { storage: AdminStorage }) {
  const [main, ...others] = storage.disks
  if (!main) {
    return (
      <section aria-label="Storage" className="mt-8 md:mt-12">
        <p className="display text-5xl text-ink-3 sm:text-7xl">No folders set</p>
        <p className="mt-3 text-[0.9375rem] text-ink-2">Set the library and downloads folders in Settings to see how much room is left.</p>
      </section>
    )
  }

  const free = splitSize(main.freeBytes)
  return (
    <section aria-label="Storage" className="mt-8 md:mt-12">
      <div className="flex flex-wrap items-end justify-between gap-x-10 gap-y-4">
        <p className="display flex items-baseline gap-3 text-[4.25rem] text-ink sm:text-[7rem] lg:text-[9.5rem]">
          <Figure value={free.value} format={(value) => value.toFixed(free.digits)} />
          <span className="heading text-2xl text-ink-2 sm:text-4xl">{free.unit} free</span>
        </p>
        <p className="max-w-sm pb-2 text-[0.9375rem] leading-relaxed text-ink-2 md:pb-5">
          Of {formatBytes(main.totalBytes)} on the disk holding <FolderPath path={main.folders[0] ?? ""} />.{" "}
          {forecast(main, storage.weeklyGrowthBytes)}
        </p>
      </div>

      <DiskBar disk={main} size="lg" />

      {others.length > 0 && (
        <div className="mt-8 grid grid-cols-1 gap-6 md:grid-cols-2">
          {others.map((disk) => (
            <div key={disk.folders.join()}>
              <p className="flex flex-wrap items-baseline justify-between gap-2 text-sm">
                <span className="text-ink">
                  {disk.folders.map((folder, index) => (
                    <React.Fragment key={folder}>
                      {index > 0 && ", "}
                      <FolderPath path={folder} />
                    </React.Fragment>
                  ))}
                </span>
                <span className="font-mono text-[0.8125rem] text-ink-2 tabular">
                  {formatBytes(disk.freeBytes)} free of {formatBytes(disk.totalBytes)}
                </span>
              </p>
              <DiskBar disk={disk} size="sm" />
            </div>
          ))}
        </div>
      )}
    </section>
  )
}

/** A folder in mono type, free to wrap after each slash. */
function FolderPath({ path }: { path: string }) {
  const parts = path.split("/")
  return (
    <span className="font-mono text-ink">
      {parts.map((part, index) => (
        <React.Fragment key={index}>
          {part}
          {index < parts.length - 1 && (
            <>
              /<wbr />
            </>
          )}
        </React.Fragment>
      ))}
    </span>
  )
}

/** One disk as a bar: what's on it from the left, free space hatched on the right, with a key. */
function DiskBar({ disk, size }: { disk: DiskUsage; size: "lg" | "sm" }) {
  const parts = segments(disk)
  return (
    <div>
      <div className={cn("mt-3 flex overflow-hidden shadow-ring", size === "lg" ? "mt-6 h-16 rounded-art md:h-20" : "h-4 rounded-full")}>
        {parts.map((segment, index) => (
          <motion.div
            key={segment.key}
            initial={{ scaleX: 0 }}
            animate={{ scaleX: 1 }}
            transition={{ delay: 0.15 + index * 0.08, duration: 0.8, ease: EASE_OUT }}
            title={`${segment.label}, ${formatBytes(segment.bytes)}`}
            className={cn("h-full min-w-[3px] origin-left border-r-2 border-paper", segment.tone)}
            style={{ width: `${disk.totalBytes > 0 ? (segment.bytes / disk.totalBytes) * 100 : 0}%` }}
          />
        ))}
        <div className="h-full flex-1" style={{ background: FREE_PATTERN }} title={`Free, ${formatBytes(disk.freeBytes)}`} />
      </div>
      {size === "lg" && (
        <div className="mt-3 flex flex-wrap gap-x-6 gap-y-2">
          {parts.map((segment) => (
            <span key={segment.key} className="inline-flex items-center gap-2 text-sm text-ink-2">
              <span className={cn("size-2.5 rounded-[3px]", segment.tone)} />
              {segment.label}
              <span className="font-mono text-[0.8125rem] text-ink tabular">{formatBytes(segment.bytes)}</span>
            </span>
          ))}
          <span className="inline-flex items-center gap-2 text-sm text-ink-2">
            <span className="size-2.5 rounded-[3px] shadow-ring" style={{ background: FREE_PATTERN }} />
            Free
            <span className="font-mono text-[0.8125rem] text-ink tabular">{formatBytes(disk.freeBytes)}</span>
          </span>
        </div>
      )}
    </div>
  )
}
