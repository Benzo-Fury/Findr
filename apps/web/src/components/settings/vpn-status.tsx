import * as React from "react"
import { ArrowsClockwiseIcon, ShieldCheckIcon, ShieldSlashIcon, ShieldWarningIcon } from "@phosphor-icons/react"
import type { VpnState, VpnStatus } from "@findr/types/vpn"
import { checkVpn, fetchVpnStatus } from "@/lib/api"
import type { StatusStyle } from "@/lib/download-status"
import { formatRelativeTime } from "@/lib/format"
import { Button } from "@/components/ui/button"
import { Skeleton } from "@/components/ui/skeleton"
import { StatusLabel } from "@/components/ui/status-label"

/** How each killswitch state is drawn. */
const VPN_STATE: Record<VpnState, StatusStyle> = {
  off: { label: "Killswitch off", icon: ShieldSlashIcon, tone: "muted" },
  up: { label: "VPN connected", icon: ShieldCheckIcon, tone: "ok" },
  down: { label: "Torrents blocked", icon: ShieldWarningIcon, tone: "bad" },
}

/** How often the panel refreshes while the page is open. */
const POLL_MS = 10_000

interface VpnStatusPanelProps {
  /** Changes whenever the VPN settings are saved, so the panel shows the new verdict at once. */
  revision: number
}

/**
 * The killswitch's live verdict at the top of its settings section: whether
 * torrents may run, why not, and what the checks saw, with a button that
 * runs every check on the spot.
 */
export function VpnStatusPanel({ revision }: VpnStatusPanelProps) {
  const [status, setStatus] = React.useState<VpnStatus | null>(null)
  const [error, setError] = React.useState<string | null>(null)
  const [checking, setChecking] = React.useState(false)

  // Load now, after every save, and on a gentle poll
  React.useEffect(() => {
    const controller = new AbortController()
    function load() {
      fetchVpnStatus({ signal: controller.signal })
        .then((next) => {
          setStatus(next)
          setError(null)
        })
        .catch((reason: unknown) => {
          if (!controller.signal.aborted) setError(reason instanceof Error ? reason.message : "Could not load the VPN status")
        })
    }
    load()
    const timer = window.setInterval(load, POLL_MS)
    return () => {
      controller.abort()
      window.clearInterval(timer)
    }
  }, [revision])

  async function checkNow() {
    setChecking(true)
    try {
      setStatus(await checkVpn())
      setError(null)
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "The check failed")
    } finally {
      setChecking(false)
    }
  }

  if (!status && !error) return <Skeleton className="h-[4.5rem] rounded-panel" />

  return (
    <div className="flex flex-col gap-3 rounded-panel bg-sunken px-4 py-3.5 sm:flex-row sm:items-center sm:justify-between">
      <div className="min-w-0 space-y-1">
        {status && <StatusLabel status={VPN_STATE[status.state]} variant="filled" />}
        <p className="text-[0.8125rem] leading-relaxed text-ink-2" aria-live="polite">
          {error ?? (status && describe(status))}
        </p>
      </div>
      <Button size="sm" icon={ArrowsClockwiseIcon} loading={checking} onClick={checkNow} className="self-start sm:self-center">
        Check now
      </Button>
    </div>
  )
}

/** One line on what the latest check found. */
function describe(status: VpnStatus): string {
  if (status.state === "off") return "Torrents run whether or not a VPN is connected."

  const seen = [
    status.interfaceName && `${status.interfaceName} at ${status.addresses.join(", ")}`,
    status.publicIp && `public IP ${status.publicIp}`,
  ].filter(Boolean)
  const checked = status.checkedAt ? ` Checked ${formatRelativeTime(status.checkedAt)}.` : ""

  if (status.state === "down") return `${status.reason ?? "The VPN is down"}.${checked}`
  return `${seen.length > 0 ? `Through ${seen.join(", ")}.` : "Every check passed."}${checked}`
}
