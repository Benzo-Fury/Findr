import * as React from "react"
import type { UpdateStatus } from "@findr/types/updates"
import { checkForUpdates, fetchUpdateStatus, installUpdate } from "@/lib/api"
import { usePolling } from "@/lib/hooks"

/**
 * Findr's own update status, and the two things an admin can do about it:
 * check now, and install. Installing restarts the server, so while it runs
 * the status is polled through the outage, and the page reloads once a new
 * version answers, picking up the new web app with it.
 */

/** How often the status is polled while an update installs. */
const INSTALL_POLL_MS = 2_000

export interface Updates {
  status: UpdateStatus | null
  /** Why the last check or install request was refused. */
  error: string | null
  checking: boolean
  /** From the moment an install is accepted until the page reloads, or the install fails. */
  installing: boolean
  check: () => Promise<void>
  install: () => Promise<void>
}

export function useUpdates(): Updates {
  const [status, setStatus] = React.useState<UpdateStatus | null>(null)
  const [error, setError] = React.useState<string | null>(null)
  const [checking, setChecking] = React.useState(false)
  /** The version that was running when an install started; any other answering means the restart is done. */
  const [installingFrom, setInstallingFrom] = React.useState<string | null>(null)

  const load = React.useCallback(() => {
    fetchUpdateStatus()
      .then((next) => {
        if (installingFrom && next.current !== installingFrom) {
          window.location.reload()
          return
        }
        setStatus(next)
        // Back to idle on the same version: the install failed, and the status says why
        if (installingFrom && next.phase === "idle") setInstallingFrom(null)
      })
      .catch(() => {
        // Unreachable while restarting; the next poll tries again
      })
  }, [installingFrom])

  React.useEffect(load, [load])
  usePolling(load, installingFrom !== null, INSTALL_POLL_MS)

  const check = React.useCallback(async () => {
    setChecking(true)
    setError(null)
    try {
      setStatus(await checkForUpdates())
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Could not check for updates")
    } finally {
      setChecking(false)
    }
  }, [])

  const install = React.useCallback(async () => {
    setError(null)
    try {
      const next = await installUpdate()
      setStatus(next)
      setInstallingFrom(next.current)
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Could not start the update")
    }
  }, [])

  return { status, error, checking, installing: installingFrom !== null, check, install }
}
