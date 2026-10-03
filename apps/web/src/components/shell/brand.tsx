import { cn } from "@/lib/utils"

interface BrandProps {
  className?: string
  /** Whether the wordmark is shown beside the logo; the logo alone is used in tight corners. */
  wordmark?: boolean
}

/** The Findr logo, with the wordmark beside it unless turned off. */
export function Brand({ className, wordmark = true }: BrandProps) {
  return (
    <span className={cn("inline-flex items-center gap-2", className)}>
      <img
        src="/findr-logo.svg"
        alt=""
        className={cn("object-contain", wordmark ? "h-6 w-9" : "h-16 w-24")}
      />
      {wordmark && <span className="display text-[1.625rem] leading-none text-ink">findr</span>}
    </span>
  )
}
