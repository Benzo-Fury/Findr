import * as React from "react"
import { useNavigate } from "react-router-dom"
import { motion } from "motion/react"
import { PlayIcon } from "@phosphor-icons/react"
import type { PlayableItem } from "@findr/types/playback"
import { episodeCode } from "@/lib/format"
import { useLibrary, type LibraryEntry } from "@/lib/library"
import { FADE, staggerDelay } from "@/lib/motion"
import { formatRemaining, itemKey, usePlayback, watchPath } from "@/lib/playback"
import { tmdbImage } from "@/lib/tmdb-image"
import { ProgressBar } from "@/components/ui/progress-bar"
import { ScrollRow } from "@/components/ui/scroll-row"

/** Most cards the row shows. */
const LIMIT = 12

/**
 * What to watch now, at the top of the Library: anything part-way through,
 * most recent first, then the next episode of each show in progress. Wide
 * backdrops set it apart from the poster grid below. Hidden when there is
 * nothing to suggest or playback is off.
 */
export function ContinueWatchingRow({ className }: { className?: string }) {
  const playback = usePlayback()
  const { entries } = useLibrary()
  const navigate = useNavigate()

  const cards = React.useMemo(() => {
    const byTitle = new Map(entries.map((entry) => [entry.title.id, entry]))
    const seen = new Set<string>()
    const picked: Array<{ item: PlayableItem; entry: LibraryEntry; resuming: boolean }> = []

    for (const [keys, resuming] of [[playback.library.continueWatching, true], [playback.library.nextUp, false]] as const) {
      for (const key of keys) {
        const id = itemKey(key)
        const item = playback.itemFor(key)
        const entry = byTitle.get(key.titleId)
        if (seen.has(id) || !item || !entry) continue
        seen.add(id)
        picked.push({ item, entry, resuming })
      }
    }
    return picked.slice(0, LIMIT)
  }, [entries, playback])

  if (!playback.enabled || cards.length === 0) return null

  return (
    <section aria-label="Continue watching" className={className}>
      <h2 className="heading mb-3 text-xl text-ink">Continue watching</h2>
      <ScrollRow label="Continue watching" trackClassName="-mx-4 gap-3 px-4 md:-mx-8 md:gap-4 md:px-8">
        {cards.map(({ item, entry, resuming }, index) => (
          <motion.div
            key={itemKey(item)}
            initial={{ opacity: 0, y: 10 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ ...FADE, delay: staggerDelay(index) }}
            className="w-64 shrink-0 snap-start md:w-80"
          >
            <ContinueWatchingCard item={item} entry={entry} resuming={resuming} onPlay={() => navigate(watchPath(item))} />
          </motion.div>
        ))}
      </ScrollRow>
    </section>
  )
}

interface ContinueWatchingCardProps {
  item: PlayableItem
  entry: LibraryEntry
  resuming: boolean
  onPlay: () => void
}

function ContinueWatchingCard({ item, entry, resuming, onPlay }: ContinueWatchingCardProps) {
  const src = tmdbImage(entry.card?.backdropPath, "backdrop")
  const title = entry.card?.title ?? ""
  const code = item.season !== null && item.episode !== null ? episodeCode(item.season, item.episode) : null
  const detail = resuming ? formatRemaining(item) : "Next episode"

  return (
    <button type="button" onClick={onPlay} aria-label={`Play ${title}${code ? ` ${code}` : ""}`} className="group/continue block w-full text-left">
      <div className="relative aspect-video overflow-hidden rounded-art bg-sunken shadow-ring">
        {src && (
          <img
            src={src}
            alt=""
            loading="lazy"
            className="size-full object-cover transition-transform duration-500 ease-out-expo group-hover/continue:scale-[1.04]"
          />
        )}
        <span className="absolute inset-0 bg-gradient-to-t from-ink/55 via-transparent to-transparent" />
        <span className="absolute left-3 top-3 flex size-10 scale-90 items-center justify-center rounded-full bg-signal text-ink opacity-0 shadow-float transition-[opacity,transform] duration-300 ease-out-expo group-hover/continue:scale-100 group-hover/continue:opacity-100 group-focus-visible/continue:scale-100 group-focus-visible/continue:opacity-100">
          <PlayIcon weight="fill" className="ml-0.5 size-5" />
        </span>
        {resuming && (
          <ProgressBar value={item.positionMs / item.durationMs} label="Watched so far" size="hair" className="absolute inset-x-3 bottom-3 w-auto bg-surface/30" />
        )}
      </div>
      <p className="mt-2.5 truncate text-[0.9375rem] font-semibold text-ink">{title}</p>
      <p className="truncate text-micro text-ink-3">
        {code && <span className="font-mono text-ink-2 tabular">{code} </span>}
        {detail}
      </p>
    </button>
  )
}
