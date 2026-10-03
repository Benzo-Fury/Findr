import * as React from "react"
import { AnimatePresence, motion } from "motion/react"
import { ArrowsClockwiseIcon, CaretDownIcon, PushPinIcon } from "@phosphor-icons/react"
import type { CandidateRecord } from "@findr/types/downloads"
import { CANDIDATE_STATUS, UNTRIED_CANDIDATE } from "@/lib/download-status"
import { formatSize } from "@/lib/format"
import { FADE, staggerDelay } from "@/lib/motion"
import { cn } from "@/lib/utils"
import { Button } from "@/components/ui/button"
import { StatusLabel } from "@/components/ui/status-label"

interface ReleaseListProps {
  candidates: CandidateRecord[]
  /** Whether the download is still running, so pending releases may yet be tried. */
  running: boolean
  /** When given, untried and rejected releases offer "Try this release". */
  onTry?: (candidateId: string) => void
  /** The release whose request is in flight. */
  tryingId?: string | null
  emptyLabel?: string
  /** How many show before "Show all". */
  initialCount?: number
}

/**
 * Every release considered for a download: what it is, how healthy its swarm
 * is, how it scored, and for rejected ones, exactly why. Long lists start
 * short and expand in place.
 */
export function ReleaseList({ candidates, running, onTry, tryingId = null, emptyLabel = "No releases found.", initialCount = 5 }: ReleaseListProps) {
  const [expanded, setExpanded] = React.useState(false)
  const shown = expanded ? candidates : candidates.slice(0, initialCount)
  const hidden = candidates.length - shown.length
  // Pending releases are only in line while the unit still needs one
  const waiting = running && !candidates.some((candidate) => candidate.status === "succeeded")

  if (candidates.length === 0) {
    return <p className="text-[0.9375rem] text-ink-2">{emptyLabel}</p>
  }

  return (
    <div>
      <ul className="flex flex-col gap-2">
        <AnimatePresence initial={false}>
          {shown.map((candidate, index) => (
            <motion.li
              key={candidate.id}
              layout="position"
              initial={{ opacity: 0, y: 8 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0 }}
              transition={{ ...FADE, delay: index >= initialCount ? staggerDelay(index - initialCount) : 0 }}
            >
              <ReleaseRow candidate={candidate} waiting={waiting} onTry={onTry} trying={tryingId === candidate.id} disabled={tryingId !== null} />
            </motion.li>
          ))}
        </AnimatePresence>
      </ul>
      {(hidden > 0 || expanded) && candidates.length > initialCount && (
        <Button variant="ghost" size="sm" iconEnd={CaretDownIcon} onClick={() => setExpanded((open) => !open)} className={cn("mt-2 [&>svg:last-child]:transition-transform", expanded && "[&>svg:last-child]:rotate-180")}>
          {expanded ? "Show fewer" : `Show all ${candidates.length}`}
        </Button>
      )}
    </div>
  )
}

interface ReleaseRowProps {
  candidate: CandidateRecord
  /** Whether a pending release is still queued to be tried. */
  waiting: boolean
  onTry?: (candidateId: string) => void
  trying: boolean
  disabled: boolean
}

function ReleaseRow({ candidate, waiting, onTry, trying, disabled }: ReleaseRowProps) {
  const { parsed } = candidate
  const canTry = onTry && candidate.status !== "succeeded" && candidate.status !== "attempting"
  const tags = [parsed.resolution, parsed.videoCodec, parsed.audioCodec, parsed.hdrFormat !== "SDR" ? parsed.hdrFormat : null, parsed.releaseType].filter(
    (tag): tag is NonNullable<typeof tag> => Boolean(tag),
  )

  return (
    <div
      className={cn(
        "rounded-[0.875rem] px-3.5 py-3 shadow-ring transition-colors",
        candidate.status === "succeeded" && "bg-ok-soft/60 shadow-[0_0_0_1px_oklch(0.5_0.12_156/0.3)]",
        candidate.status === "attempting" && "bg-signal-soft",
        candidate.status === "rejected" && "bg-paper",
      )}
    >
      <div className="flex items-start justify-between gap-3">
        <p className={cn("min-w-0 flex-1 break-all font-mono text-[0.8125rem] leading-snug", candidate.status === "rejected" ? "text-ink-2" : "text-ink")}>
          {candidate.title}
        </p>
        <StatusLabel status={candidate.status === "pending" && !waiting ? UNTRIED_CANDIDATE : CANDIDATE_STATUS[candidate.status]} className="shrink-0 text-micro" />
      </div>

      <div className="mt-2 flex flex-wrap items-center gap-1.5">
        {candidate.pinned && (
          <span className="inline-flex h-6 items-center gap-1 rounded-full bg-ink px-2 text-micro font-semibold text-surface">
            <PushPinIcon aria-hidden weight="fill" className="size-3" />
            Picked
          </span>
        )}
        {tags.map((tag) => (
          <span key={tag} className="inline-flex h-6 items-center rounded-full bg-sunken px-2 text-micro font-semibold text-ink-2">
            {tag}
          </span>
        ))}
        <span className="ml-auto font-mono text-micro text-ink-3 tabular">
          {formatSize(candidate.sizeMB)} · {candidate.seeders} seeds
          {candidate.score !== null && <> · score {candidate.score.toFixed(1)}</>}
        </span>
      </div>

      <p className="mt-1.5 truncate text-micro text-ink-3">
        {candidate.indexer}
        {parsed.group && <> / {parsed.group}</>}
      </p>

      {candidate.rejectionReason && <p className="mt-2 text-[0.8125rem] font-medium text-bad">{candidate.rejectionReason}</p>}

      {canTry && (
        <Button variant="outline" size="sm" icon={ArrowsClockwiseIcon} loading={trying} disabled={disabled} onClick={() => onTry(candidate.id)} className="mt-2.5">
          {trying ? "Starting" : "Try this release"}
        </Button>
      )}
    </div>
  )
}
