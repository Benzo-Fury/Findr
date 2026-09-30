import * as React from "react"
import { Ban, Loader2, RotateCcw, Trash2 } from "lucide-react"
import type { AttemptRecord, CandidateRecord, DownloadDetail, EpisodeRecord } from "@findr/types/downloads"
import {
  cancelDownload,
  deleteDownload,
  fetchDownload,
  retryDownload,
} from "@/lib/api"
import {
  ATTEMPT_OUTCOME,
  ATTEMPT_PHASE,
  DOWNLOAD_STATUS,
  FINISHED_STATUSES,
} from "@/lib/download-status"
import { episodeCode, formatPercent, formatRelativeTime } from "@/lib/format"
import { usePolling } from "@/lib/hooks"
import type { TMDBMeta } from "@/lib/types"
import { CandidateList } from "@/components/candidate-list"
import { EpisodeGrid } from "@/components/episode-grid"
import { StatusBadge } from "@/components/status-badge"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog"
import { Progress } from "@/components/ui/progress"
import { Skeleton } from "@/components/ui/skeleton"

/** How often an unfinished download is re-read. */
const POLL_INTERVAL = 3000

interface DownloadDetailDialogProps {
  downloadId: string
  /** Title and artwork, when the caller already has them. */
  meta?: TMDBMeta
  onClose: () => void
  /** Called after the download is deleted or changed, so lists can refresh. */
  onChanged: () => void
}

/**
 * Everything Findr knows about one download: live progress, per-episode
 * status for seasons, every attempt with its outcome and reason, and every
 * release considered — with a way to hand-pick one when the download is done.
 */
export function DownloadDetailDialog({ downloadId, meta, onClose, onChanged }: DownloadDetailDialogProps) {
  const [detail, setDetail] = React.useState<DownloadDetail | null>(null)
  const [error, setError] = React.useState<string | null>(null)
  const [busy, setBusy] = React.useState<"cancel" | "retry" | "delete" | null>(null)
  const [tryingId, setTryingId] = React.useState<string | null>(null)

  const load = React.useCallback(() => {
    fetchDownload(downloadId)
      .then(setDetail)
      .catch((e: unknown) => setError(e instanceof Error ? e.message : "Could not load the download"))
  }, [downloadId])

  React.useEffect(load, [load])

  const finished = detail ? FINISHED_STATUSES.includes(detail.status) : false
  usePolling(load, detail !== null && !finished, POLL_INTERVAL)

  /** Runs an action, reporting failures inline and refreshing afterwards. */
  async function run(action: "cancel" | "retry" | "delete", work: () => Promise<unknown>) {
    setBusy(action)
    setError(null)
    try {
      await work()
      onChanged()
      if (action === "delete") onClose()
      else load()
    } catch (e) {
      setError(e instanceof Error ? e.message : "That did not work")
    } finally {
      setBusy(null)
    }
  }

  async function handleTry(candidateId: string) {
    setTryingId(candidateId)
    await run("retry", () => retryDownload(downloadId, candidateId))
    setTryingId(null)
  }

  const heading = meta?.title
    ? `${meta.title}${detail?.season !== null && detail?.season !== undefined ? ` · Season ${detail.season}` : ""}`
    : "Download"

  return (
    <Dialog open onOpenChange={() => onClose()}>
      <DialogContent className="max-h-[90vh] max-w-3xl overflow-y-auto">
        <DialogTitle>{heading}</DialogTitle>

        {!detail ? (
          error ? <p className="text-sm text-destructive">{error}</p> : <DetailSkeleton />
        ) : (
          <div className="space-y-6">
            <Summary detail={detail} />

            <div className="flex flex-wrap gap-2">
              {!finished && (
                <Button variant="outline" className="gap-2" disabled={busy !== null} onClick={() => run("cancel", () => cancelDownload(downloadId))}>
                  {busy === "cancel" ? <Loader2 className="size-4 animate-spin" /> : <Ban className="size-4" />}
                  Cancel
                </Button>
              )}
              {finished && detail.status !== "completed" && (
                <Button className="gap-2" disabled={busy !== null} onClick={() => run("retry", () => retryDownload(downloadId))}>
                  {busy === "retry" && !tryingId ? <Loader2 className="size-4 animate-spin" /> : <RotateCcw className="size-4" />}
                  Retry
                </Button>
              )}
              <Button
                variant="ghost"
                className="gap-2 text-destructive hover:text-destructive"
                disabled={busy !== null}
                onClick={() => run("delete", () => deleteDownload(downloadId))}
              >
                {busy === "delete" ? <Loader2 className="size-4 animate-spin" /> : <Trash2 className="size-4" />}
                Delete
              </Button>
            </div>
            {error && <p className="text-sm text-destructive">{error}</p>}

            {detail.episodes.length > 0 && (
              <Section title="Episodes">
                <EpisodeGrid episodes={detail.episodes} />
              </Section>
            )}

            <Section title="Attempts" count={detail.attempts.length}>
              <AttemptList attempts={detail.attempts} candidates={detail.candidates} episodes={detail.episodes} />
            </Section>

            <Section title="Releases" count={detail.candidates.length}>
              {finished && (
                <p className="mb-3 text-sm text-muted-foreground">
                  Pick a release to try it first on the next run.
                </p>
              )}
              <CandidateGroups
                candidates={detail.candidates}
                episodes={detail.episodes}
                season={detail.season}
                onTry={finished ? handleTry : undefined}
                tryingId={tryingId}
              />
            </Section>
          </div>
        )}
      </DialogContent>
    </Dialog>
  )
}

/* -------------------------------------------------------------------------- */
/* Scoped components                                                          */
/* -------------------------------------------------------------------------- */

/** Status, message, and live progress of the running attempt. */
function Summary({ detail }: { detail: DownloadDetail }) {
  const active = detail.activeAttempt

  return (
    <div className="space-y-3 rounded-lg border p-4">
      <div className="flex flex-wrap items-center gap-2">
        <StatusBadge status={DOWNLOAD_STATUS[detail.status]} />
        {detail.run > 1 && <Badge variant="outline">Run {detail.run}</Badge>}
        <span className="text-xs text-muted-foreground">Updated {formatRelativeTime(detail.updatedAt)}</span>
      </div>

      {detail.statusMessage && <p className="text-sm text-muted-foreground">{detail.statusMessage}</p>}

      {active && (
        <div className="space-y-1.5">
          <div className="flex items-center justify-between gap-3 text-xs">
            <span className="truncate font-medium">
              {active.episodeNumber !== null && detail.season !== null && `${episodeCode(detail.season, active.episodeNumber)} · `}
              {ATTEMPT_PHASE[active.phase]}
            </span>
            <span className="shrink-0 tabular-nums text-muted-foreground">{formatPercent(active.progress)}</span>
          </div>
          <Progress value={active.progress} />
          <p className="truncate text-xs text-muted-foreground" title={active.candidateTitle}>
            {active.candidateTitle}
          </p>
        </div>
      )}

      {detail.result && detail.result.files.length > 0 && (
        <div className="text-xs text-muted-foreground">
          <p className="mb-1 font-medium text-foreground">Saved to the library</p>
          <ul className="space-y-0.5">
            {detail.result.files.map((file) => (
              <li key={file} className="truncate font-mono" title={file}>
                {file}
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  )
}

interface SectionProps {
  title: string
  count?: number
  children: React.ReactNode
}

function Section({ title, count, children }: SectionProps) {
  return (
    <section>
      <h3 className="mb-3 text-base font-semibold">
        {title}
        {count !== undefined && <span className="ml-1.5 text-sm font-normal text-muted-foreground">({count})</span>}
      </h3>
      {children}
    </section>
  )
}

interface AttemptListProps {
  attempts: AttemptRecord[]
  candidates: CandidateRecord[]
  episodes: EpisodeRecord[]
}

/** Every try, newest first, with what was tried and why it ended as it did. */
function AttemptList({ attempts, candidates, episodes }: AttemptListProps) {
  if (attempts.length === 0) return <p className="text-sm text-muted-foreground">Nothing tried yet.</p>

  const titles = new Map(candidates.map((candidate) => [candidate.id, candidate.title]))
  const numbers = new Map(episodes.map((episode) => [episode.id, episode.episodeNumber]))

  return (
    <ol className="space-y-2">
      {attempts.map((attempt) => {
        const episode = attempt.episodeId ? numbers.get(attempt.episodeId) : undefined

        return (
          <li key={attempt.id} className="rounded-lg border p-3 text-sm">
            <div className="flex items-start justify-between gap-3">
              <p className="min-w-0 flex-1 truncate font-medium" title={titles.get(attempt.candidateId)}>
                {episode !== undefined && <span className="mr-1.5 text-muted-foreground">E{String(episode).padStart(2, "0")}</span>}
                {titles.get(attempt.candidateId) ?? "Unknown release"}
              </p>
              {attempt.outcome ? (
                <StatusBadge status={ATTEMPT_OUTCOME[attempt.outcome]} className="shrink-0" />
              ) : (
                <Badge variant="purple" className="shrink-0 gap-1">
                  <Loader2 className="size-3 animate-spin" />
                  {ATTEMPT_PHASE[attempt.phase]}
                </Badge>
              )}
            </div>
            {attempt.reason && <p className="mt-1.5 text-xs text-destructive">{attempt.reason}</p>}
            <p className="mt-1 text-xs text-muted-foreground">
              Run {attempt.run} · started {formatRelativeTime(attempt.startedAt)}
            </p>
          </li>
        )
      })}
    </ol>
  )
}

interface CandidateGroupsProps {
  candidates: CandidateRecord[]
  episodes: EpisodeRecord[]
  season: number | null
  onTry?: (candidateId: string) => void
  tryingId: string | null
}

/** Releases grouped by unit: the movie or season pack first, then each episode. */
function CandidateGroups({ candidates, episodes, season, onTry, tryingId }: CandidateGroupsProps) {
  const main = candidates.filter((candidate) => candidate.episodeId === null)
  const perEpisode = episodes
    .map((episode) => ({ episode, list: candidates.filter((candidate) => candidate.episodeId === episode.id) }))
    .filter((group) => group.list.length > 0)

  return (
    <div className="space-y-5">
      {(main.length > 0 || perEpisode.length === 0) && (
        <div>
          {season !== null && <p className="mb-2 text-sm font-medium">Season packs</p>}
          <CandidateList candidates={main} onTry={onTry} tryingId={tryingId} />
        </div>
      )}
      {perEpisode.map(({ episode, list }) => (
        <div key={episode.id}>
          <p className="mb-2 text-sm font-medium">{episodeCode(season ?? 0, episode.episodeNumber)}</p>
          <CandidateList candidates={list} onTry={onTry} tryingId={tryingId} />
        </div>
      ))}
    </div>
  )
}

function DetailSkeleton() {
  return (
    <div className="space-y-4">
      <Skeleton className="h-24 w-full rounded-lg" />
      <Skeleton className="h-6 w-32" />
      <Skeleton className="h-16 w-full rounded-lg" />
      <Skeleton className="h-16 w-full rounded-lg" />
    </div>
  )
}
