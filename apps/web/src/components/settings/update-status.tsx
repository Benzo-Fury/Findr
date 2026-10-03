import { ArrowCircleUpIcon, ArrowsClockwiseIcon, CheckCircleIcon, WarningCircleIcon } from "@phosphor-icons/react"
import type { UpdateStatus } from "@findr/types/updates"
import type { StatusStyle } from "@/lib/download-status"
import { formatRelativeTime } from "@/lib/format"
import type { Updates } from "@/lib/updates"
import { Button } from "@/components/ui/button"
import { Skeleton } from "@/components/ui/skeleton"
import { StatusLabel } from "@/components/ui/status-label"

interface UpdateStatusPanelProps {
  updates: Updates
}

/**
 * The running version and what the last check found, at the top of the
 * Updates section, with a button that asks GitHub again on the spot.
 * Installing happens from the banner at the top of the page.
 */
export function UpdateStatusPanel({ updates }: UpdateStatusPanelProps) {
  const { status } = updates
  if (!status) return <Skeleton className="h-[4.5rem] rounded-panel" />

  return (
    <div className="flex flex-col gap-3 rounded-panel bg-sunken px-4 py-3.5 sm:flex-row sm:items-center sm:justify-between">
      <div className="min-w-0 space-y-1">
        <StatusLabel status={style(status)} variant="filled" />
        <p className="text-[0.8125rem] leading-relaxed text-ink-2" aria-live="polite">
          {updates.error ?? status.error ?? describe(status)}
        </p>
      </div>
      <Button size="sm" icon={ArrowsClockwiseIcon} loading={updates.checking} onClick={updates.check} className="self-start sm:self-center">
        Check now
      </Button>
    </div>
  )
}

function style(status: UpdateStatus): StatusStyle {
  if (status.available) return { label: `${status.latest?.version} available`, icon: ArrowCircleUpIcon, tone: "live" }
  if (status.error && !status.checkedAt) return { label: "Not checked", icon: WarningCircleIcon, tone: "warn" }
  return { label: "Up to date", icon: CheckCircleIcon, tone: "ok" }
}

/** How each kind of install is described. */
const INSTALL_LABELS: Record<UpdateStatus["install"], string> = {
  binary: "a standalone executable",
  source: "a source checkout, updated by hand",
  docker: "a container, updated by pulling a new image",
}

/** The running version, how it is installed, and when GitHub last answered. */
function describe(status: UpdateStatus): string {
  const install = INSTALL_LABELS[status.install]
  const checked = status.checkedAt ? ` Checked ${formatRelativeTime(status.checkedAt)}.` : ""
  return `Findr ${status.current}, running as ${install}.${checked}`
}
