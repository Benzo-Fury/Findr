import * as React from "react"
import { motion, useMotionValue, useSpring, useTransform } from "motion/react"
import { StarIcon } from "@phosphor-icons/react"
import type { StatusStyle } from "@/lib/download-status"
import { SPRING_HOVER } from "@/lib/motion"
import { useFinePointer } from "@/lib/responsive"
import type { MediaType } from "@/lib/types"
import { cn } from "@/lib/utils"
import { Highlight } from "@/components/ui/highlight"
import { Poster } from "@/components/ui/poster"
import { ProgressBar } from "@/components/ui/progress-bar"
import { StatusLabel } from "@/components/ui/status-label"

export interface PosterCardProps {
  title: string
  year?: string
  mediaType: MediaType
  posterPath: string | null
  onOpen: () => void
  /** Shared-element id for the poster, so it can fly into the title sheet. */
  layoutId?: string
  /** What Findr has done with the title, shown under the caption. */
  status?: StatusStyle
  /** Download progress: a fraction, or null while running with no figure yet. */
  progress?: number | null
  /** TMDB rating, shown when there is no status to show. */
  rating?: number
  /** Query words to highlight in the title. */
  highlight?: string[]
  eager?: boolean
  className?: string
}

/** Most a card tilts toward the pointer, in degrees. */
const MAX_TILT = 7

/**
 * A title as poster and caption. On devices that hover, the card lifts and
 * tilts toward the pointer; everywhere, it presses in when tapped. Running
 * downloads draw their progress along the poster's bottom edge.
 */
export const PosterCard = React.memo(function PosterCard({
  title,
  year,
  mediaType,
  posterPath,
  onOpen,
  layoutId,
  status,
  progress,
  rating,
  highlight,
  eager,
  className,
}: PosterCardProps) {
  const fine = useFinePointer()

  // Pointer position across the card, from -0.5 to 0.5, smoothed by a spring
  const px = useMotionValue(0)
  const py = useMotionValue(0)
  const sx = useSpring(px, SPRING_HOVER)
  const sy = useSpring(py, SPRING_HOVER)
  const rotateY = useTransform(sx, (value) => value * MAX_TILT * 2)
  const rotateX = useTransform(sy, (value) => value * -MAX_TILT * 2)
  const glareX = useTransform(sx, (value) => `${(value + 0.5) * 100}%`)
  const glareY = useTransform(sy, (value) => `${(value + 0.5) * 100}%`)

  function onPointerMove(event: React.PointerEvent<HTMLButtonElement>) {
    if (!fine) return
    const box = event.currentTarget.getBoundingClientRect()
    px.set((event.clientX - box.left) / box.width - 0.5)
    py.set((event.clientY - box.top) / box.width / 1.5 - 0.5)
  }

  function onPointerLeave() {
    px.set(0)
    py.set(0)
  }

  const running = progress !== undefined

  return (
    <motion.button
      type="button"
      onClick={() => {
        // Level the card first so the poster leaves from where it rests
        onPointerLeave()
        onOpen()
      }}
      onPointerMove={onPointerMove}
      onPointerLeave={onPointerLeave}
      whileHover={fine ? { y: -6 } : undefined}
      whileTap={{ scale: 0.97 }}
      transition={SPRING_HOVER}
      className={cn("group/card block w-full rounded-art text-left outline-none [perspective:900px]", className)}
    >
      <motion.div style={fine ? { rotateX, rotateY } : undefined} className="relative [transform-style:preserve-3d]">
        <Poster
          path={posterPath}
          title={title}
          layoutId={layoutId}
          eager={eager}
          className="shadow-ring transition-shadow duration-300 group-hover/card:shadow-lift group-focus-visible/card:ring-2 group-focus-visible/card:ring-ink group-focus-visible/card:ring-offset-2 group-focus-visible/card:ring-offset-paper"
        >
          {fine && (
            <motion.div
              aria-hidden
              style={{ "--gx": glareX, "--gy": glareY } as React.CSSProperties}
              className="pointer-events-none absolute inset-0 opacity-0 transition-opacity duration-300 [background:radial-gradient(circle_at_var(--gx)_var(--gy),oklch(1_0_0/0.28),transparent_55%)] group-hover/card:opacity-100"
            />
          )}
          {running && (
            <div className="absolute inset-x-0 bottom-0 bg-gradient-to-t from-ink/70 to-transparent px-2 pb-2 pt-8">
              <ProgressBar value={progress ?? undefined} label={`${title} progress`} size="hair" className="bg-surface/30" />
            </div>
          )}
        </Poster>
      </motion.div>

      <div className="mt-2.5 px-0.5">
        <p className="line-clamp-1 text-[0.875rem] font-semibold leading-snug text-ink">
          {highlight ? <Highlight text={title} words={highlight} /> : title}
        </p>
        <div className="mt-0.5 flex items-center gap-2 text-micro text-ink-3">
          {year && <span className="font-mono tabular">{year}</span>}
          <span>{mediaType === "tv" ? "Series" : "Film"}</span>
          {!status && rating !== undefined && rating > 0 && (
            <span className="inline-flex items-center gap-0.5 font-mono tabular">
              <StarIcon aria-hidden weight="fill" className="size-3 text-signal-strong" />
              {rating.toFixed(1)}
            </span>
          )}
        </div>
        {status && <StatusLabel status={status} className="mt-1 text-micro" />}
      </div>
    </motion.button>
  )
})
