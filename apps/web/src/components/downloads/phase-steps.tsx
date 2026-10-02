import { motion } from "motion/react"
import type { AttemptPhase } from "@findr/types/downloads"
import { PHASE_ORDER, PHASE_SHORT } from "@/lib/download-status"
import { SPRING_SNAP } from "@/lib/motion"
import { cn } from "@/lib/utils"

interface PhaseStepsProps {
  /** The live phase, or null while the download is still searching. */
  phase: AttemptPhase | null
  className?: string
}

/**
 * The four steps every attempt walks through, with the current one lit in
 * amber and the finished ones filled in ink.
 */
export function PhaseSteps({ phase, className }: PhaseStepsProps) {
  const current = phase ? PHASE_ORDER.indexOf(phase) : -1

  return (
    <ol aria-label="Steps" className={cn("flex items-center gap-1", className)}>
      {PHASE_ORDER.map((step, index) => {
        const done = index < current
        const now = index === current
        return (
          <li key={step} aria-current={now ? "step" : undefined} className="flex min-w-0 flex-1 flex-col gap-1.5">
            <span className="relative h-1 overflow-hidden rounded-full bg-ink/8">
              {(done || now) && (
                <motion.span
                  layout
                  transition={SPRING_SNAP}
                  className={cn("absolute inset-0 rounded-full", done ? "bg-ink" : "bg-signal")}
                />
              )}
            </span>
            <span className={cn("truncate text-micro font-semibold", now ? "text-ink" : done ? "text-ink-2" : "text-ink-3")}>{PHASE_SHORT[step]}</span>
          </li>
        )
      })}
    </ol>
  )
}
