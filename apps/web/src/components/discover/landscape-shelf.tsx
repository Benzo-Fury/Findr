import * as React from "react"
import { motion } from "motion/react"
import { StarIcon } from "@phosphor-icons/react"
import type { StatusStyle } from "@/lib/download-status"
import { SPRING_HOVER } from "@/lib/motion"
import { tmdbImage } from "@/lib/tmdb-image"
import type { PosterItem } from "@/lib/types"
import { ScrollRow } from "@/components/ui/scroll-row"
import { StatusLabel } from "@/components/ui/status-label"
import { usePosterActions } from "@/components/media/use-poster-actions"

interface LandscapeShelfProps {
  label: string
  scope: string
  items: PosterItem[]
}

/**
 * Wide stills instead of posters, for lists where the scene sells the title.
 * The still drifts slightly on hover; the overview appears beneath it on
 * wider screens.
 */
export function LandscapeShelf({ label, scope, items }: LandscapeShelfProps) {
  const { open, known } = usePosterActions(scope)
  const withArt = items.filter((item) => item.backdropPath)

  return (
    <ScrollRow label={label} trackClassName="-mx-4 gap-4 px-4 md:-mx-8 md:gap-6 md:px-8">
      {withArt.map((item) => (
        <Still key={`${item.mediaType}-${item.id}`} item={item} known={known(item)?.status} onOpen={() => open(item)} />
      ))}
    </ScrollRow>
  )
}

interface StillProps {
  item: PosterItem
  known: StatusStyle | undefined
  onOpen: () => void
}

function Still({ item, known, onOpen }: StillProps) {
  const [loaded, setLoaded] = React.useState(false)

  return (
    <motion.button
      type="button"
      onClick={onOpen}
      whileTap={{ scale: 0.98 }}
      transition={SPRING_HOVER}
      className="group/still w-[17rem] shrink-0 snap-start text-left outline-none md:w-[22rem]"
    >
      <div className="relative aspect-video overflow-hidden rounded-art bg-sunken shadow-ring transition-shadow duration-300 group-hover/still:shadow-lift group-focus-visible/still:ring-2 group-focus-visible/still:ring-ink group-focus-visible/still:ring-offset-2">
        {!loaded && <div className="skeleton absolute inset-0" />}
        <img
          src={tmdbImage(item.backdropPath, "backdrop") ?? undefined}
          alt=""
          loading="lazy"
          onLoad={() => setLoaded(true)}
          className="absolute inset-0 size-full object-cover transition-[transform,opacity] duration-700 ease-out-expo group-hover/still:scale-[1.06]"
          style={{ opacity: loaded ? 1 : 0 }}
        />
      </div>
      <div className="mt-3 flex items-baseline justify-between gap-3">
        <p className="heading truncate text-lg text-ink">{item.title}</p>
        {item.voteAverage > 0 && (
          <span className="inline-flex shrink-0 items-center gap-1 font-mono text-micro text-ink-2 tabular">
            <StarIcon aria-hidden weight="fill" className="size-3 text-signal-strong" />
            {item.voteAverage.toFixed(1)}
          </span>
        )}
      </div>
      {known && <StatusLabel status={known} className="mt-0.5 text-micro" />}
      {item.overview && <p className="mt-1 line-clamp-2 text-[0.8125rem] leading-relaxed text-ink-2">{item.overview}</p>}
    </motion.button>
  )
}
