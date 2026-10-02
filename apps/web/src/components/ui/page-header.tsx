import type * as React from "react"
import { motion } from "motion/react"
import { EASE_OUT } from "@/lib/motion"
import { cn } from "@/lib/utils"

interface PageHeaderProps {
  title: string
  /** A live count set beside the title, such as how many titles the library holds. */
  count?: number
  /** Controls aligned to the title's baseline on wide screens, below it on phones. */
  children?: React.ReactNode
  className?: string
}

/**
 * Each page opens with its name in condensed display type, large enough to
 * anchor the page, with its count tucked against it.
 */
export function PageHeader({ title, count, children, className }: PageHeaderProps) {
  return (
    <header className={cn("flex flex-wrap items-end justify-between gap-x-4 gap-y-5 pt-6 md:pt-10", className)}>
      <motion.h1
        initial={{ opacity: 0, y: 14 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.5, ease: EASE_OUT }}
        className="display flex items-start gap-2 text-[3.25rem] text-ink sm:text-7xl lg:text-[5.5rem]"
      >
        {title}
        {count !== undefined && (
          <span className="mt-1.5 font-mono text-sm font-medium tracking-normal text-ink-3 tabular sm:mt-3 sm:text-base">
            {count.toLocaleString()}
          </span>
        )}
      </motion.h1>
      {children && <div className="flex flex-wrap items-center gap-2 pb-1 md:pb-2">{children}</div>}
    </header>
  )
}
