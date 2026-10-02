import { AnimatePresence, motion } from "motion/react"
import { SPRING_SNAP } from "@/lib/motion"
import { cn } from "@/lib/utils"

interface CountBadgeProps {
  count: number
  /** Accessible description, such as "2 downloads running". */
  label: string
  className?: string
}

/** A small amber count that pops in when work starts and rolls as it changes. */
export function CountBadge({ count, label, className }: CountBadgeProps) {
  return (
    <AnimatePresence initial={false}>
      {count > 0 && (
        <motion.span
          initial={{ scale: 0.4, opacity: 0 }}
          animate={{ scale: 1, opacity: 1 }}
          exit={{ scale: 0.4, opacity: 0 }}
          transition={SPRING_SNAP}
          aria-label={label}
          className={cn(
            "inline-flex h-[1.125rem] min-w-[1.125rem] items-center justify-center overflow-hidden rounded-full bg-signal px-1 font-mono text-micro font-semibold leading-none text-ink tabular",
            className,
          )}
        >
          <AnimatePresence mode="popLayout" initial={false}>
            <motion.span
              key={count}
              initial={{ y: "100%" }}
              animate={{ y: 0 }}
              exit={{ y: "-100%" }}
              transition={SPRING_SNAP}
            >
              {count}
            </motion.span>
          </AnimatePresence>
        </motion.span>
      )}
    </AnimatePresence>
  )
}
