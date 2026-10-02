import { motion } from "motion/react"
import type { PosterItem } from "@/lib/types"
import { SPRING_HOVER } from "@/lib/motion"
import { Poster } from "@/components/ui/poster"
import { ScrollRow } from "@/components/ui/scroll-row"
import { StatusLabel } from "@/components/ui/status-label"
import { usePosterActions } from "@/components/media/use-poster-actions"

interface RankedShelfProps {
  label: string
  scope: string
  items: PosterItem[]
}

/**
 * A top ten. Each poster leans against its rank, set huge and hollow in the
 * display face; the numeral fills with amber when its title is hovered.
 */
export function RankedShelf({ label, scope, items }: RankedShelfProps) {
  const { open, known, layoutIdFor } = usePosterActions(scope)

  return (
    <ScrollRow label={label} trackClassName="-mx-4 gap-2 px-4 md:-mx-8 md:gap-4 md:px-8">
      {items.slice(0, 10).map((item, index) => {
        const state = known(item)
        return (
          <motion.button
            key={`${item.mediaType}-${item.id}`}
            type="button"
            onClick={() => open(item)}
            whileTap={{ scale: 0.97 }}
            transition={SPRING_HOVER}
            aria-label={`${index + 1}. ${item.title}`}
            className="group/rank relative flex shrink-0 snap-start items-end text-left outline-none"
          >
            <span
              aria-hidden
              className="display -mr-3 mb-10 select-none text-[7.5rem] leading-[0.78] text-transparent transition-colors duration-300 [-webkit-text-stroke:2px_var(--color-line-strong)] group-hover/rank:text-signal group-hover/rank:[-webkit-text-stroke-color:var(--color-signal-strong)] group-focus-visible/rank:text-signal md:-mr-4 md:text-[11rem]"
            >
              {index + 1}
            </span>
            <div className="relative w-28 pb-10 transition-transform duration-300 ease-out-expo group-hover/rank:-translate-y-1.5 md:w-40">
              <Poster
                path={item.posterPath}
                title={item.title}
                layoutId={layoutIdFor(item)}
                className="shadow-lift group-focus-visible/rank:ring-2 group-focus-visible/rank:ring-ink group-focus-visible/rank:ring-offset-2"
              />
              <span className="absolute inset-x-0 bottom-0 block">
                <span className="block truncate text-[0.8125rem] font-semibold text-ink">{item.title}</span>
                {state ? <StatusLabel status={state.status} className="text-micro" /> : <span className="block font-mono text-micro text-ink-3">{item.year}</span>}
              </span>
            </div>
          </motion.button>
        )
      })}
    </ScrollRow>
  )
}
