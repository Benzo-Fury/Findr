/**
 * First-run setup: which steps a server status shows as done, and a note in
 * browser storage that setup is under way, so the wizard reopens at once when
 * the app loads after the account step rather than after a status round trip.
 */

import type { SetupStatus } from "@findr/types/setup"

/** The steps of first-run setup, in order. */
export type StepId = "account" | "services" | "library" | "tools" | "done"

/** The browser-storage key marking setup as under way. */
const PENDING_KEY = "findr.setup.pending"

/** Whether each signed-in step's requirements are met. */
export function stepsDone(status: SetupStatus): Record<"services" | "library" | "tools", boolean> {
  const { downloads, movies, series } = status.paths
  return {
    services: status.tmdb.configured && status.prowlarr.configured,
    library: [downloads, movies, series].every((path) => path.set && path.writable),
    tools: status.tools.every((tool) => tool.path !== null),
  }
}

/** The first step that still needs something, or `done`. */
export function firstOpenStep(status: SetupStatus): StepId {
  const done = stepsDone(status)
  if (!done.services) return "services"
  if (!done.library) return "library"
  if (!done.tools) return "tools"
  return "done"
}

/** Notes that setup is under way. Storage may be unavailable; the wizard then opens after its status check. */
export function markSetupPending(): void {
  try {
    sessionStorage.setItem(PENDING_KEY, "1")
  } catch {}
}

/** Whether setup was noted as under way in this tab. */
export function setupPending(): boolean {
  try {
    return sessionStorage.getItem(PENDING_KEY) === "1"
  } catch {
    return false
  }
}

/** Clears the note once setup is finished. */
export function clearSetupPending(): void {
  try {
    sessionStorage.removeItem(PENDING_KEY)
  } catch {}
}
