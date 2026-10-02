import { TONE_FILL, TONE_TEXT, type StatusStyle } from "@/lib/download-status"
import { cn } from "@/lib/utils"

interface StatusLabelProps {
  status: StatusStyle
  /** `plain` is icon and text; `filled` adds a tinted pill for emphasis. */
  variant?: "plain" | "filled"
  className?: string
}

/** A pipeline state as icon and words, in the tone that state is drawn in. */
export function StatusLabel({ status, variant = "plain", className }: StatusLabelProps) {
  const StatusIcon = status.icon
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 whitespace-nowrap text-[0.8125rem] font-medium",
        variant === "filled" ? cn("h-7 rounded-full px-2.5", TONE_FILL[status.tone]) : TONE_TEXT[status.tone],
        className,
      )}
    >
      <StatusIcon
        aria-hidden
        weight="bold"
        className={cn("size-3.5 shrink-0", status.animated && "animate-[spin_1.6s_linear_infinite]")}
      />
      {status.label}
    </span>
  )
}
