import type * as React from "react"
import { cn } from "@/lib/utils"

interface KbdProps {
  children: React.ReactNode
  className?: string
}

/** A keyboard key, for shortcut hints. */
export function Kbd({ children, className }: KbdProps) {
  return (
    <kbd
      className={cn(
        "inline-flex h-5 min-w-5 items-center justify-center rounded-[5px] bg-surface px-1.5 font-mono text-micro text-ink-2 shadow-[0_0_0_1px_var(--color-line-strong),0_1px_0_var(--color-line-strong)]",
        className,
      )}
    >
      {children}
    </kbd>
  )
}
