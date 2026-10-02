import * as React from "react"
import { AnimatePresence, motion } from "motion/react"
import { MagnifyingGlassIcon, XIcon } from "@phosphor-icons/react"
import { FADE } from "@/lib/motion"
import { cn } from "@/lib/utils"
import { INPUT_CLASS } from "@/components/ui/field"
import { Kbd } from "@/components/ui/kbd"

interface SearchFieldProps extends Omit<React.ComponentProps<"input">, "onChange" | "value"> {
  value: string
  onChange: (value: string) => void
  /** Accessible name; also used as the placeholder unless one is given. */
  label: string
  /** A key that focuses the field from anywhere on the page, shown as a hint. */
  shortcut?: string
}

/**
 * A search input with a clear button and an optional shortcut hint. Escape
 * clears it first, then lets the key bubble.
 */
export const SearchField = React.forwardRef<HTMLInputElement, SearchFieldProps>(function SearchField(
  { value, onChange, label, shortcut, className, placeholder, onKeyDown, ...props },
  ref,
) {
  return (
    <div className={cn("group relative", className)}>
      <MagnifyingGlassIcon
        aria-hidden
        weight="bold"
        className="pointer-events-none absolute left-4 top-1/2 size-4 -translate-y-1/2 text-ink-3 transition-colors group-focus-within:text-ink"
      />
      <input
        ref={ref}
        type="search"
        aria-label={label}
        placeholder={placeholder ?? label}
        value={value}
        autoComplete="off"
        spellCheck={false}
        onChange={(event) => onChange(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Escape" && value) {
            event.preventDefault()
            event.stopPropagation()
            onChange("")
          }
          onKeyDown?.(event)
        }}
        className={cn(INPUT_CLASS, "pl-10 pr-12 [&::-webkit-search-cancel-button]:hidden")}
        {...props}
      />
      <div className="absolute right-2 top-1/2 flex -translate-y-1/2 items-center">
        <AnimatePresence initial={false} mode="popLayout">
          {value ? (
            <motion.button
              key="clear"
              type="button"
              aria-label="Clear search"
              onClick={() => onChange("")}
              initial={{ opacity: 0, scale: 0.6 }}
              animate={{ opacity: 1, scale: 1 }}
              exit={{ opacity: 0, scale: 0.6 }}
              transition={FADE}
              className="flex size-7 items-center justify-center rounded-full text-ink-2 transition-colors hover:bg-line hover:text-ink"
            >
              <XIcon weight="bold" className="size-3.5" />
            </motion.button>
          ) : (
            shortcut && (
              <motion.span key="hint" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} className="mr-1.5 hidden md:block">
                <Kbd>{shortcut}</Kbd>
              </motion.span>
            )
          )}
        </AnimatePresence>
      </div>
    </div>
  )
})
