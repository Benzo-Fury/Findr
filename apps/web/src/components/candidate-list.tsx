import { Loader2 } from "lucide-react"
import type { CandidateRecord } from "@findr/types/downloads"
import { CANDIDATE_STATUS } from "@/lib/download-status"
import { formatSize } from "@/lib/format"
import { cn } from "@/lib/utils"
import { StatusBadge } from "@/components/status-badge"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"

interface CandidateListProps {
  candidates: CandidateRecord[]
  /** When given, each untried or rejected release offers a "Try this" action. */
  onTry?: (candidateId: string) => void
  /** The candidate whose "Try this" request is in flight. */
  tryingId?: string | null
  /** Label shown above the list when it is empty. */
  emptyLabel?: string
}

/**
 * Every release considered for a download: its parsed quality, swarm and
 * size, how it scored, and — for rejected ones — exactly why.
 */
export function CandidateList({ candidates, onTry, tryingId = null, emptyLabel = "No releases found." }: CandidateListProps) {
  if (candidates.length === 0) {
    return <p className="text-sm text-muted-foreground">{emptyLabel}</p>
  }

  return (
    <div className="space-y-2">
      {candidates.map((candidate) => (
        <CandidateRow
          key={candidate.id}
          candidate={candidate}
          onTry={onTry}
          trying={tryingId === candidate.id}
          disabled={tryingId !== null}
        />
      ))}
    </div>
  )
}

interface CandidateRowProps {
  candidate: CandidateRecord
  onTry?: (candidateId: string) => void
  trying: boolean
  disabled: boolean
}

function CandidateRow({ candidate, onTry, trying, disabled }: CandidateRowProps) {
  const { parsed } = candidate
  const canTry = onTry && candidate.status !== "succeeded" && candidate.status !== "attempting"

  return (
    <div
      className={cn(
        "rounded-lg border p-3",
        candidate.status === "succeeded" && "border-emerald-500/40 bg-emerald-500/5",
        candidate.status === "rejected" && "opacity-75",
      )}
    >
      <div className="flex items-start justify-between gap-3">
        <p className="min-w-0 flex-1 truncate text-sm font-medium" title={candidate.title}>
          {candidate.title}
        </p>
        <StatusBadge status={CANDIDATE_STATUS[candidate.status]} className="shrink-0" />
      </div>

      <div className="mt-2 flex flex-wrap items-center gap-1.5">
        {parsed.resolution && <Badge variant="secondary">{parsed.resolution}</Badge>}
        {parsed.videoCodec && <Badge variant="secondary">{parsed.videoCodec}</Badge>}
        {parsed.audioCodec && <Badge variant="secondary">{parsed.audioCodec}</Badge>}
        {parsed.hdrFormat && parsed.hdrFormat !== "SDR" && <Badge variant="info">{parsed.hdrFormat}</Badge>}
        {parsed.releaseType && <Badge variant="outline">{parsed.releaseType}</Badge>}
        {candidate.pinned && <Badge variant="default">Picked</Badge>}
      </div>

      <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
        <span>{formatSize(candidate.sizeMB)}</span>
        <span>{candidate.seeders} seeders</span>
        {candidate.score !== null && <span>Score {candidate.score.toFixed(1)}</span>}
        <span className="truncate">{candidate.indexer}</span>
        {parsed.group && <span className="truncate">{parsed.group}</span>}
      </div>

      {candidate.rejectionReason && (
        <p className="mt-2 text-xs text-destructive">{candidate.rejectionReason}</p>
      )}

      {canTry && (
        <Button
          variant="outline"
          size="sm"
          className="mt-2 gap-1.5"
          disabled={disabled}
          onClick={() => onTry(candidate.id)}
        >
          {trying && <Loader2 className="size-3 animate-spin" />}
          {trying ? "Starting…" : "Try this release"}
        </Button>
      )}
    </div>
  )
}
