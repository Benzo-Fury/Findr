import { CircleNotchIcon } from "@phosphor-icons/react"
import { cn } from "@/lib/utils"

interface SpinnerProps {
  className?: string
}

/** A small turning ring for actions in flight. Pages load with skeletons instead. */
export function Spinner({ className }: SpinnerProps) {
  return <CircleNotchIcon aria-hidden weight="bold" className={cn("size-4 animate-[spin_0.8s_linear_infinite]", className)} />
}
