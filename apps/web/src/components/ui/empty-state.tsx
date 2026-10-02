import type * as React from "react"
import type { Icon } from "@phosphor-icons/react"
import { cn } from "@/lib/utils"

interface EmptyStateProps {
  icon: Icon
  title: string
  description?: React.ReactNode
  /** What to do about it, usually one button. */
  action?: React.ReactNode
  className?: string
}

/** What a view says when it has nothing to show, and how to change that. */
export function EmptyState({ icon: StateIcon, title, description, action, className }: EmptyStateProps) {
  return (
    <div className={cn("flex flex-col items-start gap-4 py-16 md:py-24", className)}>
      <span className="flex size-12 items-center justify-center rounded-full bg-signal-soft text-signal-ink">
        <StateIcon aria-hidden weight="bold" className="size-6" />
      </span>
      <div className="max-w-[46ch]">
        <h2 className="heading text-2xl text-ink">{title}</h2>
        {description && <p className="mt-2 text-[0.9375rem] leading-relaxed text-ink-2">{description}</p>}
      </div>
      {action}
    </div>
  )
}
