import { motion } from "motion/react"
import { SPRING_SNAP } from "@/lib/motion"
import { cn } from "@/lib/utils"

interface WeightBarProps {
  weights: { key: string; label: string; value: number }[]
  /** The weight being hovered or edited, drawn in amber. */
  focused: string | null
  onFocus: (key: string | null) => void
}

/** Segments narrower than this share show no label inside. */
const LABEL_SHARE = 0.11

/**
 * The scoring weights as shares of one bar, so the effect of an edit is
 * visible as it is typed. Segments resize with a spring; the one being
 * pointed at or edited lights up and is read out underneath.
 */
export function WeightBar({ weights, focused, onFocus }: WeightBarProps) {
  const total = weights.reduce((sum, weight) => sum + Math.max(0, weight.value), 0)
  const current = weights.find((weight) => weight.key === focused)

  return (
    <div aria-hidden className="mb-2">
      <div className="flex h-10 w-full gap-[3px] overflow-hidden rounded-full">
        {weights.map((weight, index) => {
          const share = total > 0 ? Math.max(0, weight.value) / total : 0
          return (
            <motion.div
              key={weight.key}
              layout
              transition={SPRING_SNAP}
              onPointerEnter={() => onFocus(weight.key)}
              onPointerLeave={() => onFocus(null)}
              style={{ flexGrow: share, flexBasis: 0 }}
              className={cn(
                "flex min-w-0 items-center justify-center overflow-hidden transition-colors duration-200",
                focused === weight.key ? "bg-signal text-ink" : index % 2 === 0 ? "bg-ink text-surface" : "bg-ink-2 text-surface",
                share === 0 && "hidden",
              )}
            >
              {share >= LABEL_SHARE && <span className="truncate px-2 text-micro font-semibold">{weight.label}</span>}
            </motion.div>
          )
        })}
      </div>
      <p className="mt-2 min-h-5 text-[0.8125rem] text-ink-2">
        {current && total > 0 ? (
          <>
            <span className="font-semibold text-ink">{current.label}</span> adds up to <span className="font-mono tabular">{current.value}</span> of <span className="font-mono tabular">{total}</span> points, or{" "}
            <span className="font-mono font-semibold text-ink tabular">{Math.round((Math.max(0, current.value) / total) * 100)}%</span> of the score.
          </>
        ) : (
          "Point at a segment or edit a weight to see its share of the score."
        )}
      </p>
    </div>
  )
}
