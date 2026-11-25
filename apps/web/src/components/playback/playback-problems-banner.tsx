import * as React from "react"
import { AnimatePresence, motion } from "motion/react"
import { Link } from "react-router-dom"
import { ArrowRightIcon, WarningCircleIcon, XIcon } from "@phosphor-icons/react"
import type { PlaybackDiagnostic } from "@findr/types/playback"
import { fetchPlaybackDiagnostics } from "@/lib/api"
import { isAdmin, useSession } from "@/lib/auth"
import { FADE } from "@/lib/motion"
import { usePlayback } from "@/lib/playback"
import { cn } from "@/lib/utils"
import { Button } from "@/components/ui/button"
import { withCode } from "@/components/settings/playback-checks"

/** Remembers which set of problems an admin dismissed, so a new one shows again. */
const DISMISSED_KEY = "findr:playback-problems-dismissed"

/**
 * Tells admins when something stops playback working as it should here,
 * such as hardware the container can't reach, and leads to Settings, where
 * each problem says how to fix it. Things that only make playback slower
 * stay in Settings.
 */
export function PlaybackProblemsBanner({ className }: { className?: string }) {
  const { data: session } = useSession()
  const { enabled } = usePlayback()
  const admin = Boolean(session && isAdmin(session))
  const [problems, setProblems] = React.useState<PlaybackDiagnostic[]>([])
  const [dismissed, setDismissed] = React.useState(readDismissed)

  React.useEffect(() => {
    if (!admin || !enabled) return
    const controller = new AbortController()
    fetchPlaybackDiagnostics({ signal: controller.signal })
      .then((result) => setProblems(result.items.filter((item) => item.level === "problem")))
      .catch(() => {
        // Only a hint; Settings shows the checks and their errors
      })
    return () => controller.abort()
  }, [admin, enabled])

  const signature = problems.map((item) => item.id).sort().join(",")
  const shown = admin && enabled && problems.length > 0 && dismissed !== signature
  const first = problems[0]

  function dismiss() {
    setDismissed(signature)
    try {
      localStorage.setItem(DISMISSED_KEY, signature)
    } catch {
      // Remembering is a convenience only
    }
  }

  return (
    <AnimatePresence initial={false}>
      {shown && first && (
        <motion.div role="status" initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: "auto" }} exit={{ opacity: 0, height: 0 }} transition={FADE} className={cn("overflow-hidden", className)}>
          <div className="flex flex-col gap-3 rounded-panel bg-surface px-4 py-3.5 shadow-ring sm:flex-row sm:items-center sm:gap-4">
            <div className="flex min-w-0 flex-1 items-start gap-3">
              <span className="flex size-9 shrink-0 items-center justify-center rounded-full bg-bad-soft text-bad">
                <WarningCircleIcon aria-hidden weight="bold" className="size-5" />
              </span>
              <div className="min-w-0 pt-px">
                <p className="text-sm font-semibold text-ink">
                  {problems.length === 1 ? first.title : `${problems.length} things stop playback working as it should`}
                </p>
                <p className="mt-0.5 text-[0.8125rem] leading-relaxed text-ink-2 [overflow-wrap:anywhere]">
                  {problems.length === 1 ? withCode(first.detail) : problems.map((item) => item.title).join(". ") + "."}
                </p>
              </div>
            </div>
            <div className="flex shrink-0 items-center gap-1.5 self-end sm:self-center">
              <Link
                to="/settings#playback"
                className="inline-flex h-8 items-center gap-1.5 rounded-full bg-ink px-3 text-[0.8125rem] font-medium text-surface transition-colors hover:bg-ink/88"
              >
                How to fix
                <ArrowRightIcon aria-hidden weight="bold" className="size-3.5" />
              </Link>
              <Button variant="ghost" size="sm" iconOnly icon={XIcon} aria-label="Dismiss until something else goes wrong" onClick={dismiss} />
            </div>
          </div>
        </motion.div>
      )}
    </AnimatePresence>
  )
}

function readDismissed(): string | null {
  try {
    return localStorage.getItem(DISMISSED_KEY)
  } catch {
    return null
  }
}
