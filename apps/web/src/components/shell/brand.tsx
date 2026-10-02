import { cn } from "@/lib/utils"

interface BrandProps {
  className?: string
}

/** The Findr mark and wordmark. */
export function Brand({ className }: BrandProps) {
  return (
    <span className={cn("inline-flex items-center gap-2", className)}>
      <img src="/findr-logo.svg" alt="" className="h-6 w-9 object-contain" />
      <span className="display text-[1.625rem] leading-none text-ink">findr</span>
    </span>
  )
}
