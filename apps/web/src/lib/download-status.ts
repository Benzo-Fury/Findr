/**
 * How download, episode, candidate and attempt states are presented. The one
 * place these labels, icons and tones are defined, so every page agrees.
 */

import {
  CheckCircleIcon,
  CircleDashedIcon,
  CircleNotchIcon,
  ClockIcon,
  DownloadSimpleIcon,
  MagnifyingGlassIcon,
  ProhibitIcon,
  WarningCircleIcon,
  XCircleIcon,
  type Icon,
} from "@phosphor-icons/react"
import type {
  AttemptOutcome,
  AttemptPhase,
  CandidateStatus,
  DownloadStatus,
  EpisodeStatus,
} from "@findr/types/downloads"

/**
 * The colour family a state is drawn in. `live` is work in progress and uses
 * the accent; the rest are semantic.
 */
export type StatusTone = "neutral" | "live" | "ok" | "warn" | "bad" | "muted"

export interface StatusStyle {
  label: string
  icon: Icon
  tone: StatusTone
  /** Animates the icon while the state is one the pipeline is actively working in. */
  animated?: boolean
}

export const DOWNLOAD_STATUS: Record<DownloadStatus, StatusStyle> = {
  queued: { label: "Queued", icon: ClockIcon, tone: "neutral" },
  searching: { label: "Searching", icon: MagnifyingGlassIcon, tone: "live", animated: true },
  downloading: { label: "Downloading", icon: DownloadSimpleIcon, tone: "live", animated: true },
  completed: { label: "In library", icon: CheckCircleIcon, tone: "ok" },
  partial: { label: "Partial", icon: WarningCircleIcon, tone: "warn" },
  failed: { label: "Failed", icon: XCircleIcon, tone: "bad" },
  cancelled: { label: "Cancelled", icon: ProhibitIcon, tone: "muted" },
}

export const EPISODE_STATUS: Record<EpisodeStatus, StatusStyle> = {
  pending: { label: "Pending", icon: ClockIcon, tone: "neutral" },
  searching: { label: "Searching", icon: MagnifyingGlassIcon, tone: "live", animated: true },
  downloading: { label: "Downloading", icon: CircleNotchIcon, tone: "live", animated: true },
  completed: { label: "Saved", icon: CheckCircleIcon, tone: "ok" },
  failed: { label: "Failed", icon: XCircleIcon, tone: "bad" },
  unaired: { label: "Not aired", icon: CircleDashedIcon, tone: "muted" },
  cancelled: { label: "Cancelled", icon: ProhibitIcon, tone: "muted" },
}

export const CANDIDATE_STATUS: Record<CandidateStatus, StatusStyle> = {
  pending: { label: "Waiting", icon: ClockIcon, tone: "neutral" },
  attempting: { label: "Trying", icon: CircleNotchIcon, tone: "live", animated: true },
  rejected: { label: "Rejected", icon: XCircleIcon, tone: "bad" },
  succeeded: { label: "Used", icon: CheckCircleIcon, tone: "ok" },
}

/**
 * A pending release that nothing will try: its download has finished, or
 * another release for the same unit already succeeded.
 */
export const UNTRIED_CANDIDATE: StatusStyle = { label: "Not tried", icon: CircleDashedIcon, tone: "muted" }

export const ATTEMPT_OUTCOME: Record<AttemptOutcome, StatusStyle> = {
  succeeded: { label: "Succeeded", icon: CheckCircleIcon, tone: "ok" },
  failed: { label: "Failed", icon: XCircleIcon, tone: "bad" },
  interrupted: { label: "Interrupted", icon: WarningCircleIcon, tone: "warn" },
  cancelled: { label: "Cancelled", icon: ProhibitIcon, tone: "muted" },
}

export const ATTEMPT_PHASE: Record<AttemptPhase, string> = {
  metadata: "Fetching file list",
  downloading: "Downloading",
  sterilizing: "Sterilizing",
  saving: "Saving to library",
  done: "Done",
}

/** The phases a live attempt moves through, in order, for progress steppers. */
export const PHASE_ORDER: readonly AttemptPhase[] = ["metadata", "downloading", "sterilizing", "saving"]

/** Short phase names for compact steppers. */
export const PHASE_SHORT: Record<AttemptPhase, string> = {
  metadata: "Files",
  downloading: "Download",
  sterilizing: "Clean",
  saving: "Save",
  done: "Done",
}

/** Statuses a download never leaves on its own. */
export const FINISHED_STATUSES: readonly DownloadStatus[] = ["completed", "partial", "failed", "cancelled"]

/** Whether a download is still running or waiting to run. */
export function isActive(status: DownloadStatus): boolean {
  return !FINISHED_STATUSES.includes(status)
}

/** Text colour for each tone. */
export const TONE_TEXT: Record<StatusTone, string> = {
  neutral: "text-ink-2",
  live: "text-ink",
  ok: "text-ok",
  warn: "text-warn",
  bad: "text-bad",
  muted: "text-ink-3",
}

/** Soft background and text for each tone, for filled status labels. */
export const TONE_FILL: Record<StatusTone, string> = {
  neutral: "bg-sunken text-ink-2",
  live: "bg-signal text-ink",
  ok: "bg-ok-soft text-ok",
  warn: "bg-warn-soft text-warn",
  bad: "bg-bad-soft text-bad",
  muted: "bg-sunken text-ink-3",
}
