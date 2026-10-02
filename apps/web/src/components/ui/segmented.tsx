import * as React from "react"
import { motion } from "motion/react"
import type { Icon } from "@phosphor-icons/react"
import { SPRING_SNAP } from "@/lib/motion"
import { cn } from "@/lib/utils"

export interface SegmentOption<T extends string> {
  value: T
  label: string
  icon?: Icon
  count?: number
}

interface SegmentedProps<T extends string> {
  /** Accessible name for the group. */
  label: string
  options: readonly SegmentOption<T>[]
  value: T
  onChange: (value: T) => void
  size?: "sm" | "md"
  className?: string
}

/**
 * One choice from a few, as a pill track with an amber indicator that slides
 * to the selection. A radio group for assistive technology, driven by arrow
 * keys as well as clicks.
 */
export function Segmented<T extends string>({ label, options, value, onChange, size = "md", className }: SegmentedProps<T>) {
  const id = React.useId()
  const refs = React.useRef<(HTMLButtonElement | null)[]>([])

  // Arrow keys move the selection and the focus together
  function onKeyDown(event: React.KeyboardEvent, index: number) {
    const step = event.key === "ArrowRight" || event.key === "ArrowDown" ? 1 : event.key === "ArrowLeft" || event.key === "ArrowUp" ? -1 : 0
    if (!step) return
    event.preventDefault()
    const next = (index + step + options.length) % options.length
    const option = options[next]
    if (!option) return
    onChange(option.value)
    refs.current[next]?.focus()
  }

  return (
    <div role="radiogroup" aria-label={label} className={cn("inline-flex rounded-full bg-sunken p-1", className)}>
      {options.map((option, index) => {
        const selected = option.value === value
        const OptionIcon = option.icon
        return (
          <button
            key={option.value}
            ref={(node) => {
              refs.current[index] = node
            }}
            type="button"
            role="radio"
            aria-checked={selected}
            tabIndex={selected ? 0 : -1}
            onClick={() => onChange(option.value)}
            onKeyDown={(event) => onKeyDown(event, index)}
            className={cn(
              "relative inline-flex items-center gap-1.5 rounded-full font-medium transition-colors duration-200",
              size === "sm" ? "h-7 px-3 text-[0.8125rem]" : "h-8 px-3.5 text-sm",
              selected ? "text-ink" : "text-ink-2 hover:text-ink",
            )}
          >
            {selected && (
              <motion.span
                layoutId={`segment-${id}`}
                transition={SPRING_SNAP}
                className="absolute inset-0 rounded-full bg-surface shadow-[0_1px_2px_oklch(0.2_0.02_265/0.12),0_0_0_1px_oklch(0.2_0.02_265/0.05)]"
              />
            )}
            <span className="relative inline-flex items-center gap-1.5">
              {OptionIcon && <OptionIcon aria-hidden weight="bold" className="size-3.5" />}
              {option.label}
              {option.count !== undefined && (
                <span className="font-mono text-micro tabular text-ink-3">{option.count.toLocaleString()}</span>
              )}
            </span>
          </button>
        )
      })}
    </div>
  )
}
