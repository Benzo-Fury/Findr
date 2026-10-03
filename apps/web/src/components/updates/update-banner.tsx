import * as React from "react"
import { AnimatePresence, motion } from "motion/react"
import { ArrowCircleUpIcon, ArrowUpRightIcon, XIcon } from "@phosphor-icons/react"
import type { UpdateStatus } from "@findr/types/updates"
import { isAdmin, useSession } from "@/lib/auth"
import { FADE } from "@/lib/motion"
import type { Updates } from "@/lib/updates"
import { cn } from "@/lib/utils"
import { Button } from "@/components/ui/button"

/** Remembers the version a user dismissed the banner for, so the next release shows again. */
const DISMISSED_KEY = "findr:update-dismissed"

interface UpdateBannerProps {
  updates: Updates
  /** Lets the banner be hidden until the next release. Settings, where updates are managed, keeps it. */
  dismissible?: boolean
  className?: string
}

/**
 * Says a new version of Findr is out. Admins of a standalone executable can
 * install it from here; a source checkout is told how to update by hand, and
 * everyone else is asked to tell an admin.
 */
export function UpdateBanner({ updates, dismissible = false, className }: UpdateBannerProps) {
  const { data: session } = useSession()
  const [dismissed, setDismissed] = React.useState(readDismissed)
  const { status } = updates
  const latest = status?.latest
  // Installing here, or already underway when the page loaded
  const installing = updates.installing || (status !== null && status.phase !== "idle")

  const shown = Boolean(status?.available && latest) && (installing || !dismissible || dismissed !== latest?.version)

  function dismiss() {
    if (!latest) return
    setDismissed(latest.version)
    try {
      localStorage.setItem(DISMISSED_KEY, latest.version)
    } catch {
      // Remembering is a convenience only
    }
  }

  return (
    <AnimatePresence initial={false}>
      {shown && status && latest && session && (
        <motion.div
          role="status"
          initial={{ opacity: 0, height: 0 }}
          animate={{ opacity: 1, height: "auto" }}
          exit={{ opacity: 0, height: 0 }}
          transition={FADE}
          className={cn("overflow-hidden", className)}
        >
          <div className="flex flex-col gap-3 rounded-panel bg-surface px-4 py-3.5 shadow-ring sm:flex-row sm:items-center sm:gap-4">
            <div className="flex min-w-0 flex-1 items-start gap-3">
              <span className="flex size-9 shrink-0 items-center justify-center rounded-full bg-signal-soft text-signal-ink">
                <ArrowCircleUpIcon aria-hidden weight="bold" className="size-5" />
              </span>
              <div className="min-w-0 pt-px">
                <p className="text-sm font-semibold text-ink">{headline(status, installing)}</p>
                <p className="mt-0.5 text-[0.8125rem] leading-relaxed text-ink-2">{detail(status, installing, isAdmin(session))}</p>
                {(updates.error ?? status.error) && !installing && (
                  <p className="mt-1 text-[0.8125rem] font-medium leading-relaxed text-bad">{updates.error ?? status.error}</p>
                )}
              </div>
            </div>

            <div className="flex shrink-0 items-center gap-1.5 self-end sm:self-center">
              <a
                href={latest.url}
                target="_blank"
                rel="noreferrer"
                className="inline-flex h-8 items-center gap-1.5 rounded-full px-3 text-[0.8125rem] font-medium text-ink-2 transition-colors hover:bg-sunken hover:text-ink"
              >
                Release notes
                <ArrowUpRightIcon aria-hidden weight="bold" className="size-3.5" />
              </a>
              {isAdmin(session) && status.install === "binary" && (
                <Button
                  variant="signal"
                  size="sm"
                  loading={installing}
                  disabled={status.blocked !== null}
                  onClick={updates.install}
                >
                  {installing ? "Updating" : "Update now"}
                </Button>
              )}
              {dismissible && !installing && (
                <Button variant="ghost" size="sm" iconOnly icon={XIcon} aria-label="Dismiss until the next release" onClick={dismiss} />
              )}
            </div>
          </div>
        </motion.div>
      )}
    </AnimatePresence>
  )
}

function headline(status: UpdateStatus, installing: boolean): string {
  const version = status.latest?.version
  if (status.phase === "restarting") return `Restarting into Findr ${version}`
  if (installing) return `Updating to Findr ${version}`
  return `Findr ${version} is available`
}

/** What happens next, or why it cannot happen here. */
function detail(status: UpdateStatus, installing: boolean, admin: boolean): React.ReactNode {
  if (status.phase === "restarting") return "This page reloads as soon as Findr is back."
  if (installing) return "Downloading the new version. Findr restarts once it is in place."

  const current = `You're on ${status.current}.`
  if (!admin) return `${current} Ask an admin to update.`

  switch (status.blocked) {
    case "source_install":
      return (
        <>
          {current} Check out <code className="font-mono text-[0.75rem] text-ink">v{status.latest?.version}</code>, run{" "}
          <code className="font-mono text-[0.75rem] text-ink">bun install</code> and{" "}
          <code className="font-mono text-[0.75rem] text-ink">bun run build</code>, then restart Findr.
        </>
      )
    case "docker_install":
      return (
        <>
          {current} Pull the new image and recreate the container, e.g.{" "}
          <code className="font-mono text-[0.75rem] text-ink">docker compose pull && docker compose up -d</code>.
        </>
      )
    case "no_asset":
      return `${current} This release has no build for this platform, so download it from GitHub.`
    case "not_writable":
      return `${current} Findr cannot replace its own executable here, so swap in the new release by hand.`
    case "downloads_active":
      return `${current} Updating waits until no downloads are queued or running.`
    default:
      return `${current} Findr restarts to finish, which takes a few seconds. Your settings and library stay as they are.`
  }
}

function readDismissed(): string | null {
  try {
    return localStorage.getItem(DISMISSED_KEY)
  } catch {
    return null
  }
}
