import * as React from "react"
import { motion } from "motion/react"
import type { Icon } from "@phosphor-icons/react"
import { SPRING_SNAP } from "@/lib/motion"
import { cn } from "@/lib/utils"

interface ChipProps extends Omit<React.ComponentProps<"button">, "onChange"> {
  selected: boolean
  /** A count shown after the label, such as how many titles a filter keeps. */
  count?: number
  icon?: Icon
}

/**
 * A toggleable filter. Selected chips fill with ink; their counts tick over
 * without moving anything else.
 */
export function Chip({ selected, count, icon: ChipIcon, className, children, ...props }: ChipProps) {
  return (
    <motion.button
      type="button"
      aria-pressed={selected}
      layout="position"
      transition={SPRING_SNAP}
      className={cn(
        "inline-flex h-9 shrink-0 items-center gap-1.5 rounded-full px-3.5 text-[0.8125rem] font-medium",
        "transition-[background-color,color,box-shadow,transform] duration-200 active:scale-[0.96]",
        selected
          ? "bg-ink text-surface"
          : "bg-surface text-ink-2 shadow-ring hover:text-ink hover:shadow-[0_0_0_1px_var(--color-line-strong)]",
        className,
      )}
      {...(props as React.ComponentProps<typeof motion.button>)}
    >
      {ChipIcon && <ChipIcon aria-hidden weight="bold" className="size-3.5" />}
      {children}
      {count !== undefined && (
        <span className={cn("font-mono text-micro tabular", selected ? "text-surface/70" : "text-ink-3")}>
          {count.toLocaleString()}
        </span>
      )}
    </motion.button>
  )
}
