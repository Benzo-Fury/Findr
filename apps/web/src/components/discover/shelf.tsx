import type * as React from "react"
import { motion } from "motion/react"
import { ArrowRightIcon } from "@phosphor-icons/react"
import { EASE_OUT } from "@/lib/motion"
import { Button } from "@/components/ui/button"

interface ShelfProps {
  title: string
  /** Opens the whole list behind this shelf. */
  onSeeAll?: () => void
  children: React.ReactNode
}

/** A titled band on the discover page that rises into place as it scrolls into view. */
export function Shelf({ title, onSeeAll, children }: ShelfProps) {
  return (
    <motion.section
      aria-label={title}
      initial={{ opacity: 0, y: 28 }}
      whileInView={{ opacity: 1, y: 0 }}
      viewport={{ once: true, margin: "0px 0px -12% 0px" }}
      transition={{ duration: 0.6, ease: EASE_OUT }}
      className="mt-14 md:mt-20"
    >
      <div className="mb-4 flex items-end justify-between gap-4 md:mb-5">
        <h2 className="heading text-2xl text-ink md:text-[2rem]">{title}</h2>
        {onSeeAll && (
          <Button variant="ghost" size="sm" iconEnd={ArrowRightIcon} onClick={onSeeAll} className="shrink-0 [&>svg]:transition-transform hover:[&>svg]:translate-x-0.5">
            See all
          </Button>
        )}
      </div>
      {children}
    </motion.section>
  )
}
