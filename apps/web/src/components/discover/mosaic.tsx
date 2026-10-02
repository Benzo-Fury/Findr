import { motion } from "motion/react"
import { StarIcon } from "@phosphor-icons/react"
import { EASE_OUT, staggerDelay } from "@/lib/motion"
import type { PosterItem } from "@/lib/types"
import { cn } from "@/lib/utils"
import { Poster } from "@/components/ui/poster"
import { usePosterActions } from "@/components/media/use-poster-actions"

interface MosaicProps {
  scope: string
  items: PosterItem[]
}

/** One lead poster and eight beside it: exactly nine cells, no gaps at any width. */
const CELLS = 9

/**
 * A wall of posters with one title given double size. Captions stay out of
 * the way until a poster is hovered or focused, then slide up over a scrim.
 */
export function Mosaic({ scope, items }: MosaicProps) {
  const { open, layoutIdFor } = usePosterActions(scope)
  const cells = items.slice(0, CELLS)

  return (
    <div className="grid grid-cols-3 gap-2 md:grid-cols-6 md:gap-3">
      {cells.map((item, index) => (
        <motion.button
          key={`${item.mediaType}-${item.id}`}
          type="button"
          onClick={() => open(item)}
          aria-label={item.title}
          initial={{ opacity: 0, scale: 0.96 }}
          whileInView={{ opacity: 1, scale: 1 }}
          viewport={{ once: true }}
          whileTap={{ scale: 0.98 }}
          transition={{ duration: 0.5, ease: EASE_OUT, delay: staggerDelay(index) }}
          className={cn("group/tile relative overflow-hidden rounded-art text-left outline-none", index === 0 && "col-span-2 row-span-2")}
        >
          <Poster
            path={item.posterPath}
            title={item.title}
            size={index === 0 ? "posterLarge" : "poster"}
            layoutId={layoutIdFor(item)}
            className={cn("h-full w-full transition-transform duration-700 ease-out-expo group-hover/tile:scale-[1.04] group-focus-visible/tile:ring-2 group-focus-visible/tile:ring-ink", index === 0 && "aspect-auto")}
          />
          <span className="pointer-events-none absolute inset-x-0 bottom-0 translate-y-2 bg-gradient-to-t from-ink/85 to-transparent p-3 pt-10 opacity-0 transition-[opacity,transform] duration-300 ease-out-expo group-hover/tile:translate-y-0 group-hover/tile:opacity-100 group-focus-visible/tile:translate-y-0 group-focus-visible/tile:opacity-100">
            <span className={cn("heading block text-surface", index === 0 ? "text-2xl" : "text-sm")}>{item.title}</span>
            <span className="mt-1 inline-flex items-center gap-1 font-mono text-micro text-surface/80 tabular">
              <StarIcon aria-hidden weight="fill" className="size-3 text-signal" />
              {item.voteAverage.toFixed(1)}
              {item.year && <span className="ml-1.5">{item.year}</span>}
            </span>
          </span>
        </motion.button>
      ))}
    </div>
  )
}
