import * as React from "react"
import { motion } from "motion/react"
import { FilmSlateIcon } from "@phosphor-icons/react"
import { SPRING_PANEL } from "@/lib/motion"
import { tmdbImage, type ImageSize } from "@/lib/tmdb-image"
import { cn } from "@/lib/utils"

interface PosterProps {
  path: string | null | undefined
  title: string
  size?: Extract<ImageSize, "thumb" | "poster" | "posterLarge">
  /** Shared-element id, so the same poster can fly between a grid and a sheet. */
  layoutId?: string
  /** Load immediately instead of when near the viewport. */
  eager?: boolean
  className?: string
  children?: React.ReactNode
}

/**
 * Poster artwork at a fixed 2:3 ratio, so space is reserved before the image
 * arrives. The image fades in over a shimmer; a title without artwork gets a
 * typographic stand-in rather than a broken image.
 */
export function Poster({ path, title, size = "poster", layoutId, eager, className, children }: PosterProps) {
  const [loaded, setLoaded] = React.useState(false)
  const [failed, setFailed] = React.useState(false)
  const src = tmdbImage(path, size)

  return (
    <motion.div
      layoutId={layoutId}
      transition={SPRING_PANEL}
      className={cn("relative aspect-[2/3] overflow-hidden rounded-art bg-sunken", className)}
    >
      {src && !failed ? (
        <>
          {!loaded && <div aria-hidden className="skeleton absolute inset-0" />}
          <img
            src={src}
            alt=""
            loading={eager ? "eager" : "lazy"}
            decoding="async"
            draggable={false}
            onLoad={() => setLoaded(true)}
            onError={() => setFailed(true)}
            className={cn(
              "absolute inset-0 size-full object-cover transition-opacity duration-500 ease-out-expo",
              loaded ? "opacity-100" : "opacity-0",
            )}
          />
        </>
      ) : (
        <div className="absolute inset-0 flex flex-col justify-between p-3 text-ink-3">
          <FilmSlateIcon aria-hidden weight="bold" className="size-5" />
          <span className="heading line-clamp-4 text-base text-ink-2">{title}</span>
        </div>
      )}
      {children}
    </motion.div>
  )
}
