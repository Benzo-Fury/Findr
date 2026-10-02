import * as React from "react"
import type { Icon } from "@phosphor-icons/react"
import { cn } from "@/lib/utils"
import { Spinner } from "@/components/ui/spinner"

/**
 * The one button. Pill-shaped, with a tactile press, a visible focus ring,
 * and a loading state that keeps its width so nothing shifts.
 *
 * - `signal` is the primary action of a view (amber, ink text).
 * - `ink` is a strong secondary action.
 * - `outline` and `ghost` are quiet actions; `danger` removes something.
 */

type Variant = "signal" | "ink" | "outline" | "ghost" | "danger"
type Size = "sm" | "md" | "lg"

const VARIANTS: Record<Variant, string> = {
  signal:
    "bg-signal text-ink shadow-[inset_0_-2px_0_oklch(0.2_0.02_265/0.12)] hover:bg-signal-strong disabled:bg-sunken disabled:text-ink-3 disabled:shadow-none",
  ink: "bg-ink text-surface hover:bg-ink/88 disabled:bg-ink-3",
  outline: "bg-surface text-ink shadow-ring hover:bg-sunken hover:shadow-[0_0_0_1px_var(--color-line-strong)] disabled:text-ink-3",
  ghost: "text-ink-2 hover:bg-sunken hover:text-ink disabled:text-ink-3 disabled:hover:bg-transparent",
  danger: "text-bad hover:bg-bad-soft disabled:text-ink-3",
}

const SIZES: Record<Size, { base: string; icon: string; square: string }> = {
  sm: { base: "h-8 gap-1.5 px-3 text-[0.8125rem]", icon: "size-4", square: "size-8" },
  md: { base: "h-10 gap-2 px-4 text-sm", icon: "size-[1.125rem]", square: "size-10" },
  lg: { base: "h-12 gap-2.5 px-6 text-[0.9375rem]", icon: "size-5", square: "size-12" },
}

export interface ButtonProps extends React.ComponentProps<"button"> {
  variant?: Variant
  size?: Size
  icon?: Icon
  /** Places the icon after the label. */
  iconEnd?: Icon
  /** Shows a spinner in place of the icon and blocks clicks. */
  loading?: boolean
  /** Renders a round icon-only button; `aria-label` is then required. */
  iconOnly?: boolean
}

export function Button({
  variant = "outline",
  size = "md",
  icon: IconStart,
  iconEnd: IconEnd,
  loading = false,
  iconOnly = false,
  className,
  children,
  disabled,
  type = "button",
  ...props
}: ButtonProps) {
  const sizing = SIZES[size]

  return (
    <button
      type={type}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      className={cn(
        "relative inline-flex shrink-0 select-none items-center justify-center whitespace-nowrap rounded-full font-medium",
        "transition-[transform,background-color,color,box-shadow] duration-200 ease-out-expo",
        "active:scale-[0.96] disabled:active:scale-100",
        "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ink",
        VARIANTS[variant],
        iconOnly ? sizing.square : sizing.base,
        className,
      )}
      {...props}
    >
      {loading ? (
        <Spinner className={sizing.icon} />
      ) : (
        IconStart && <IconStart aria-hidden weight="bold" className={sizing.icon} />
      )}
      {!iconOnly && children}
      {IconEnd && !loading && <IconEnd aria-hidden weight="bold" className={sizing.icon} />}
    </button>
  )
}
