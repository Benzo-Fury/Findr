import { AnimatePresence, motion } from "motion/react"
import { ArrowCounterClockwiseIcon, CheckIcon } from "@phosphor-icons/react"
import { SPRING_PANEL } from "@/lib/motion"
import { Button } from "@/components/ui/button"
import { Kbd } from "@/components/ui/kbd"

interface SaveDockProps {
  /** Titles of sections with unsaved edits. */
  dirty: string[]
  invalidCount: number
  saving: boolean
  error: string | null
  onSave: () => void
  onDiscard: () => void
}

/** Lists names as "A", "A and B", or "A, B and 2 more". */
function describe(names: string[]): string {
  if (names.length <= 2) return names.join(" and ")
  return `${names.slice(0, 2).join(", ")} and ${names.length - 2} more`
}

/**
 * Unsaved edits gather here instead of behind a save button per section: a
 * dock rises from the bottom while anything differs from the server, says
 * where, and saves it all at once.
 */
export function SaveDock({ dirty, invalidCount, saving, error, onSave, onDiscard }: SaveDockProps) {
  return (
    <AnimatePresence>
      {dirty.length > 0 && (
        <motion.div
          initial={{ y: 96, opacity: 0 }}
          animate={{ y: 0, opacity: 1 }}
          exit={{ y: 96, opacity: 0 }}
          transition={SPRING_PANEL}
          role="region"
          aria-label="Unsaved changes"
          className="fixed inset-x-3 bottom-[calc(var(--tabs-height)+env(safe-area-inset-bottom)+0.75rem)] z-[var(--z-chrome)] mx-auto flex max-w-2xl flex-wrap items-center gap-3 rounded-panel bg-ink py-3 pl-5 pr-3 text-surface shadow-float md:bottom-6"
        >
          <div className="min-w-0 flex-1">
            <p className="text-sm font-semibold">Unsaved changes</p>
            <p className="truncate text-[0.8125rem] text-surface/70">
              {error ?? (invalidCount > 0 ? `Fix ${invalidCount === 1 ? "1 field" : `${invalidCount} fields`} before saving` : `In ${describe(dirty)}`)}
            </p>
          </div>
          <Button variant="ghost" size="md" icon={ArrowCounterClockwiseIcon} onClick={onDiscard} disabled={saving} className="text-surface/80 hover:bg-surface/10 hover:text-surface">
            Discard
          </Button>
          <Button variant="signal" size="md" icon={CheckIcon} loading={saving} disabled={invalidCount > 0} onClick={onSave}>
            Save changes
            <Kbd className="ml-1 hidden bg-ink/10 text-ink shadow-none lg:inline-flex">⌘S</Kbd>
          </Button>
        </motion.div>
      )}
    </AnimatePresence>
  )
}
