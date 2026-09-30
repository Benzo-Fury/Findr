import type { EpisodeRecord } from "@findr/types/downloads"
import { EPISODE_STATUS } from "@/lib/download-status"
import { cn } from "@/lib/utils"

interface EpisodeGridProps {
  episodes: EpisodeRecord[]
}

/** Badge colours per variant, matching the Badge component's palette. */
const TILE_STYLES: Record<string, string> = {
  success: "border-emerald-500/40 bg-emerald-500/10 text-emerald-600 dark:text-emerald-400",
  destructive: "border-destructive/40 bg-destructive/10 text-destructive",
  purple: "border-purple-500/40 bg-purple-500/10 text-purple-600 dark:text-purple-400 animate-pulse",
  info: "border-blue-500/40 bg-blue-500/10 text-blue-600 dark:text-blue-400 animate-pulse",
  outline: "border-dashed text-muted-foreground",
  secondary: "bg-muted text-muted-foreground",
}

/**
 * A season at a glance: one tile per episode, coloured by status, with the
 * status and any failure reason on hover.
 */
export function EpisodeGrid({ episodes }: EpisodeGridProps) {
  return (
    <div className="flex flex-wrap gap-1.5">
      {episodes.map((episode) => {
        const status = EPISODE_STATUS[episode.status]
        const detail = episode.statusMessage ? `${status.label}: ${episode.statusMessage}` : status.label

        return (
          <span
            key={episode.id}
            title={`Episode ${episode.episodeNumber} — ${detail}`}
            className={cn(
              "flex h-8 min-w-10 items-center justify-center rounded-md border px-2 text-xs font-medium tabular-nums",
              TILE_STYLES[status.variant] ?? TILE_STYLES.secondary,
            )}
          >
            E{String(episode.episodeNumber).padStart(2, "0")}
          </span>
        )
      })}
    </div>
  )
}
