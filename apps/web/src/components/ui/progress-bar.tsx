import { cn } from "@/lib/utils"

interface ProgressBarProps {
  /** 0 to 1; leave out while the amount is unknown. */
  value?: number
  /** Accessible name. */
  label: string
  size?: "hair" | "sm" | "md"
  className?: string
}

const HEIGHTS = { hair: "h-[3px]", sm: "h-1.5", md: "h-2.5" } as const

/**
 * Progress drawn in amber. The fill moves by transform, so frequent updates
 * stay smooth; an unknown amount shows a travelling sweep instead.
 */
export function ProgressBar({ value, label, size = "sm", className }: ProgressBarProps) {
  const known = value !== undefined
  const fraction = known ? Math.min(1, Math.max(0, value)) : 0

  return (
    <div
      role="progressbar"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={known ? Math.round(fraction * 100) : undefined}
      className={cn("relative w-full overflow-hidden rounded-full bg-ink/8", HEIGHTS[size], className)}
    >
      {known ? (
        <div
          className="absolute inset-y-0 left-0 w-full origin-left rounded-full bg-signal transition-transform duration-700 ease-out-expo"
          style={{ transform: `scaleX(${fraction})` }}
        />
      ) : (
        <div className="absolute inset-y-0 w-1/3 animate-[sweep_1.4s_ease-in-out_infinite] rounded-full bg-signal" />
      )}
    </div>
  )
}
