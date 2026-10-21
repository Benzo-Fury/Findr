import * as React from "react"
import { useNavigate } from "react-router-dom"
import { CheckCircleIcon, CheckIcon, CircleIcon, PlayIcon } from "@phosphor-icons/react"
import type { PlayableItem } from "@findr/types/playback"
import { markPlayed } from "@/lib/api"
import { episodeCode } from "@/lib/format"
import { formatClock, formatRemaining, usePlayback, watchPath } from "@/lib/playback"
import type { MediaType } from "@/lib/types"
import { cn } from "@/lib/utils"
import { Button } from "@/components/ui/button"
import { ProgressBar } from "@/components/ui/progress-bar"
import { useToast } from "@/components/ui/toast"

interface PlayActionsProps {
  titleId: string
  mediaType: MediaType
  /** The season picked in the sheet, for shows. */
  season: number
  /** Draw a rule beneath, when other actions follow in the panel. */
  separated: boolean
}

/**
 * Play, Resume and watched state for what is on disk, at the top of the
 * title sheet's action panel. A movie gets one button; a season gets a
 * button for the episode to watch next and a grid of every episode it has.
 * Renders nothing while playback is off or nothing is playable yet.
 */
export function PlayActions({ titleId, mediaType, season, separated }: PlayActionsProps) {
  const playback = usePlayback()
  const navigate = useNavigate()
  const toast = useToast()

  if (!playback.enabled) return null
  const items = playback
    .itemsOf(titleId)
    .filter((item) => (mediaType === "movie" ? item.season === null : item.season === season))
    .sort((a, b) => (a.episode ?? 0) - (b.episode ?? 0))
  if (items.length === 0) return null

  // Carry on with what was started, else the first unwatched, else from the top
  const featured = items.find((item) => item.positionMs > 0) ?? items.find((item) => !item.played) ?? items[0]
  if (!featured) return null

  async function toggleWatched(item: PlayableItem) {
    try {
      await markPlayed({ titleId: item.titleId, season: item.season, episode: item.episode, played: !item.played })
      playback.refresh()
    } catch (error) {
      toast({ title: "Could not update", description: error instanceof Error ? error.message : undefined, tone: "bad" })
    }
  }

  const code = featured.season !== null && featured.episode !== null ? episodeCode(featured.season, featured.episode) : null
  const resuming = featured.positionMs > 0

  return (
    <div className={cn(separated && "mb-5 border-b border-line pb-5")}>
      <div className="flex flex-wrap items-center gap-3">
        <Button variant="signal" size="lg" icon={PlayIcon} onClick={() => navigate(watchPath(featured))}>
          {resuming ? "Resume" : "Play"}
          {code && <span className="font-mono tabular">{code}</span>}
        </Button>
        {mediaType === "movie" && (
          <Button variant="ghost" icon={featured.played ? CheckCircleIcon : CircleIcon} onClick={() => toggleWatched(featured)}>
            {featured.played ? "Watched" : "Mark watched"}
          </Button>
        )}
        {resuming && <span className="font-mono text-[0.8125rem] text-ink-2 tabular">{formatRemaining(featured)}</span>}
      </div>
      {resuming && <ProgressBar value={featured.positionMs / featured.durationMs} label="Watched so far" size="hair" className="mt-3 max-w-sm" />}

      {mediaType === "tv" && (
        <div className="mt-4 grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-4">
          {items.map((item) => (
            <EpisodeTile
              key={item.episode}
              item={item}
              current={item === featured}
              onPlay={() => navigate(watchPath(item))}
              onToggleWatched={() => toggleWatched(item)}
            />
          ))}
        </div>
      )}
    </div>
  )
}

interface EpisodeTileProps {
  item: PlayableItem
  current: boolean
  onPlay: () => void
  onToggleWatched: () => void
}

/** One episode on disk: its number and length, how far in, and whether it was watched. */
function EpisodeTile({ item, current, onPlay, onToggleWatched }: EpisodeTileProps) {
  const started = item.positionMs > 0

  return (
    <div className={cn("group/episode relative rounded-[0.875rem] bg-surface shadow-ring transition-shadow hover:shadow-lift", current && "shadow-[0_0_0_2px_var(--color-signal)]")}>
      <button type="button" onClick={onPlay} aria-label={`Play episode ${item.episode}`} className="block w-full px-3 pb-2.5 pt-2.5 text-left">
        <span className="flex items-center gap-1.5">
          <PlayIcon aria-hidden weight="fill" className="size-3 text-ink-3 transition-colors group-hover/episode:text-signal-ink" />
          <span className="font-mono text-[0.8125rem] font-semibold text-ink tabular">E{String(item.episode ?? 0).padStart(2, "0")}</span>
        </span>
        <span className="mt-0.5 block font-mono text-micro text-ink-3 tabular">
          {started ? formatRemaining(item) : formatClock(item.durationMs)}
        </span>
        {started && <ProgressBar value={item.positionMs / item.durationMs} label="Watched so far" size="hair" className="mt-2" />}
      </button>
      <button
        type="button"
        onClick={onToggleWatched}
        aria-label={item.played ? `Mark episode ${item.episode} unwatched` : `Mark episode ${item.episode} watched`}
        aria-pressed={item.played}
        className={cn(
          "absolute right-1.5 top-1.5 flex size-7 items-center justify-center rounded-full transition-[background-color,color,opacity]",
          item.played ? "bg-ok-soft text-ok" : "text-ink-3 opacity-0 hover:bg-sunken hover:text-ink focus-visible:opacity-100 group-hover/episode:opacity-100",
        )}
      >
        <CheckIcon weight="bold" className="size-3.5" />
      </button>
    </div>
  )
}
