import { cn } from "@/lib/utils"

interface SkeletonProps {
  className?: string
}

/** A shimmering placeholder sized like what it stands in for, so nothing shifts on load. */
export function Skeleton({ className }: SkeletonProps) {
  return <div aria-hidden className={cn("skeleton rounded-art", className)} />
}
