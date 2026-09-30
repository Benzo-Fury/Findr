import { cn } from "@/lib/utils"

interface ProgressProps {
  /** 0–1. */
  value: number
  className?: string
}

/** A thin horizontal progress bar. */
export function Progress({ value, className }: ProgressProps) {
  const percent = Math.round(Math.min(Math.max(value, 0), 1) * 100)

  return (
    <div
      role="progressbar"
      aria-valuenow={percent}
      aria-valuemin={0}
      aria-valuemax={100}
      className={cn("h-1.5 w-full overflow-hidden rounded-full bg-muted", className)}
    >
      <div className="h-full rounded-full bg-primary transition-[width] duration-500" style={{ width: `${percent}%` }} />
    </div>
  )
}
