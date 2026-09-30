import { Badge } from "@/components/ui/badge"
import type { StatusStyle } from "@/lib/download-status"
import { cn } from "@/lib/utils"

interface StatusBadgeProps {
  /** One entry from the status tables in `lib/download-status`. */
  status: StatusStyle
  className?: string
}

/** A labelled, icon-led badge for any pipeline state. */
export function StatusBadge({ status, className }: StatusBadgeProps) {
  const Icon = status.icon

  return (
    <Badge variant={status.variant} className={cn("gap-1", className)}>
      <Icon className={cn("size-3", status.animated && "animate-pulse")} />
      {status.label}
    </Badge>
  )
}
