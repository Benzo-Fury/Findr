import * as React from "react"
import { AnimatePresence, motion } from "motion/react"
import { CheckIcon } from "@phosphor-icons/react"
import { FADE } from "@/lib/motion"
import { cn } from "@/lib/utils"

/**
 * The dark panels that open over the player and the TV remote: a floating
 * panel under the top bar's buttons, radio groups of options inside it, and a
 * passing notice for something that didn't work.
 */

/** Where a panel sits, under the top bar's buttons. */
export const PANEL_CLASS =
  "absolute right-4 top-16 w-[min(20rem,calc(100vw-2rem))] origin-top-right overflow-hidden rounded-panel bg-[oklch(0.2_0.012_265/0.92)] p-2 text-surface shadow-float backdrop-blur-xl md:right-6"

/** How long a notice stays up. */
const NOTICE_MS = 5000

/** Closes an overlay panel on Escape before the key reaches the player's shortcuts. */
export function useEscape(onClose: () => void): void {
  React.useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.stopPropagation()
        onClose()
      }
    }
    window.addEventListener("keydown", onKey, true)
    return () => window.removeEventListener("keydown", onKey, true)
  }, [onClose])
}

interface PanelProps {
  label: string
  onClose: () => void
  className?: string
  children: React.ReactNode
}

/** A floating panel that closes on Escape. */
export function Panel({ label, onClose, className, children }: PanelProps) {
  useEscape(onClose)
  return (
    <motion.div
      role="dialog"
      aria-label={label}
      initial={{ opacity: 0, y: -6, scale: 0.98 }}
      animate={{ opacity: 1, y: 0, scale: 1 }}
      exit={{ opacity: 0, y: -6, scale: 0.98 }}
      transition={FADE}
      className={cn(PANEL_CLASS, className)}
    >
      {children}
    </motion.div>
  )
}

export function PanelGroup({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div role="radiogroup" aria-label={label} className="mb-1 border-b border-surface/10 pb-1 last:mb-0 last:border-b-0 last:pb-0">
      <p className="px-3 pb-1 pt-2 text-micro font-semibold text-surface/55">{label}</p>
      {children}
    </div>
  )
}

export function PanelOption({ selected, onClick, children }: { selected: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      type="button"
      role="radio"
      aria-checked={selected}
      onClick={onClick}
      className="flex w-full items-center gap-2 rounded-[0.75rem] px-3 py-2 text-left text-[0.875rem] transition-colors hover:bg-surface/10"
    >
      <CheckIcon aria-hidden weight="bold" className={cn("size-4 shrink-0 text-signal", !selected && "invisible")} />
      {children}
    </button>
  )
}

/** One option's trailing detail, such as a track's codec. */
export function PanelDetail({ children }: { children: React.ReactNode }) {
  return <span className="ml-auto shrink-0 pl-3 font-mono text-micro text-surface/55">{children}</span>
}

/** A message shown for a few seconds under the top bar, cleared through `onDone`. */
export function Notice({ message, onDone }: { message: string | null; onDone: () => void }) {
  React.useEffect(() => {
    if (!message) return
    const timer = setTimeout(onDone, NOTICE_MS)
    return () => clearTimeout(timer)
  }, [message, onDone])

  return (
    <AnimatePresence>
      {message && (
        <motion.p
          role="status"
          initial={{ opacity: 0, y: -6 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, y: -6 }}
          transition={FADE}
          className="absolute left-1/2 top-20 max-w-[calc(100vw-2rem)] -translate-x-1/2 rounded-full bg-[oklch(0.2_0.012_265/0.92)] px-4 py-2 text-center text-[0.875rem] text-surface shadow-float backdrop-blur-xl"
        >
          {message}
        </motion.p>
      )}
    </AnimatePresence>
  )
}
