/**
 * How download, episode, candidate and attempt states are presented. The one
 * place these labels and badge variants are defined, so every page agrees.
 */

import {
  Ban,
  CheckCircle2,
  CircleDashed,
  Clock,
  Download,
  Loader2,
  Search,
  TriangleAlert,
  XCircle,
  type LucideIcon,
} from "lucide-react"
import type {
  AttemptOutcome,
  AttemptPhase,
  CandidateStatus,
  DownloadStatus,
  EpisodeStatus,
} from "@findr/types/downloads"

/** Badge variants available on the shared Badge component. */
export type BadgeVariant = "default" | "info" | "purple" | "warning" | "success" | "destructive" | "secondary" | "outline"

export interface StatusStyle {
  label: string
  icon: LucideIcon
  variant: BadgeVariant
  /** Animates the icon while the state is one the pipeline is actively working in. */
  animated?: boolean
}

export const DOWNLOAD_STATUS: Record<DownloadStatus, StatusStyle> = {
  queued: { label: "Queued", icon: Clock, variant: "secondary" },
  searching: { label: "Searching", icon: Search, variant: "info", animated: true },
  downloading: { label: "Downloading", icon: Download, variant: "purple", animated: true },
  completed: { label: "Completed", icon: CheckCircle2, variant: "success" },
  partial: { label: "Partial", icon: TriangleAlert, variant: "warning" },
  failed: { label: "Failed", icon: XCircle, variant: "destructive" },
  cancelled: { label: "Cancelled", icon: Ban, variant: "outline" },
}

export const EPISODE_STATUS: Record<EpisodeStatus, StatusStyle> = {
  pending: { label: "Pending", icon: Clock, variant: "secondary" },
  searching: { label: "Searching", icon: Search, variant: "info", animated: true },
  downloading: { label: "Downloading", icon: Loader2, variant: "purple", animated: true },
  completed: { label: "Saved", icon: CheckCircle2, variant: "success" },
  failed: { label: "Failed", icon: XCircle, variant: "destructive" },
  unaired: { label: "Not aired", icon: CircleDashed, variant: "outline" },
  cancelled: { label: "Cancelled", icon: Ban, variant: "outline" },
}

export const CANDIDATE_STATUS: Record<CandidateStatus, StatusStyle> = {
  pending: { label: "Waiting", icon: Clock, variant: "secondary" },
  attempting: { label: "Trying", icon: Loader2, variant: "purple", animated: true },
  rejected: { label: "Rejected", icon: XCircle, variant: "destructive" },
  succeeded: { label: "Used", icon: CheckCircle2, variant: "success" },
}

export const ATTEMPT_OUTCOME: Record<AttemptOutcome, StatusStyle> = {
  succeeded: { label: "Succeeded", icon: CheckCircle2, variant: "success" },
  failed: { label: "Failed", icon: XCircle, variant: "destructive" },
  interrupted: { label: "Interrupted", icon: TriangleAlert, variant: "warning" },
  cancelled: { label: "Cancelled", icon: Ban, variant: "outline" },
}

export const ATTEMPT_PHASE: Record<AttemptPhase, string> = {
  metadata: "Fetching file list",
  downloading: "Downloading",
  sterilizing: "Sterilizing",
  saving: "Saving to library",
  done: "Done",
}

/** Statuses a download never leaves on its own. */
export const FINISHED_STATUSES: readonly DownloadStatus[] = ["completed", "partial", "failed", "cancelled"]
