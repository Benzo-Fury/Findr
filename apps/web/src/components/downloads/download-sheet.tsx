import * as React from "react"
import { AnimatePresence, motion } from "motion/react"
import { ArrowRightIcon, ArrowsClockwiseIcon, ProhibitIcon, TrashIcon } from "@phosphor-icons/react"
import type { AttemptRecord, CandidateRecord, DownloadDetail, EpisodeRecord } from "@findr/types/downloads"
import { cancelDownload, deleteDownload, fetchDownload, retryDownload } from "@/lib/api"
import { ATTEMPT_OUTCOME, ATTEMPT_PHASE, DOWNLOAD_STATUS, EPISODE_STATUS, TONE_FILL, isActive } from "@/lib/download-status"
import { episodeCode, formatPercent, formatRelativeTime } from "@/lib/format"
import { usePolling } from "@/lib/hooks"
import { useLibrary } from "@/lib/library"
import { FADE, staggerDelay } from "@/lib/motion"
import { cardKey, useTitleCards } from "@/lib/title-cards"
import type { TitleRef } from "@/lib/title-route"
import { cn } from "@/lib/utils"
import { PhaseSteps } from "@/components/downloads/phase-steps"
import { ReleaseList } from "@/components/downloads/release-list"
import { Button } from "@/components/ui/button"
import { Poster } from "@/components/ui/poster"
import { ProgressBar } from "@/components/ui/progress-bar"
import { Sheet, SheetClose } from "@/components/ui/sheet"
import { Skeleton } from "@/components/ui/skeleton"
import { StatusLabel } from "@/components/ui/status-label"
import { useToast } from "@/components/ui/toast"

interface DownloadSheetProps {
  downloadId: string | null
  onClose: () => void
  onOpenTitle: (ref: TitleRef) => void
}

/** How often an unfinished download is re-read. */
const POLL_MS = 3000

/**
 * Everything about one download: live progress, what to do next, each
 * episode of a season, every attempt and why it ended, and every release
 * considered, with a way to hand-pick one once the download is done.
 */
export function DownloadSheet({ downloadId, onClose, onOpenTitle }: DownloadSheetProps) {
  const [shown, setShown] = React.useState(downloadId)
  React.useEffect(() => {
    if (downloadId) setShown(downloadId)
  }, [downloadId])

  return (
    <Sheet open={downloadId !== null} onClose={onClose} label="Download details" width="md">
      {shown && <Body key={shown} downloadId={shown} onClose={onClose} onOpenTitle={onOpenTitle} />}
    </Sheet>
  )
}

interface BodyProps {
  downloadId: string
  onClose: () => void
  onOpenTitle: (ref: TitleRef) => void
}

function Body({ downloadId, onClose, onOpenTitle }: BodyProps) {
  const { refresh } = useLibrary()
  const toast = useToast()
  const [detail, setDetail] = React.useState<DownloadDetail | null>(null)
  const [error, setError] = React.useState<string | null>(null)
  const [busy, setBusy] = React.useState<"cancel" | "retry" | "delete" | null>(null)
  const [tryingId, setTryingId] = React.useState<string | null>(null)
  const [confirmDelete, setConfirmDelete] = React.useState(false)

  const load = React.useCallback(() => {
    fetchDownload(downloadId)
      .then((value) => {
        setDetail(value)
        setError(null)
      })
      .catch((e: unknown) => setError(e instanceof Error ? e.message : "Could not load the download"))
  }, [downloadId])

  React.useEffect(load, [load])
  const running = detail ? isActive(detail.status) : false
  usePolling(load, running, POLL_MS)

  const key = detail ? cardKey(detail.mediaType, detail.tmdbId) : ""
  const card = useTitleCards(key ? [key] : undefined)(key)

  /** Runs an action, reports failures inline, and refreshes everything after. */
  async function run(action: "cancel" | "retry" | "delete", work: () => Promise<unknown>, done: string) {
    setBusy(action)
    setError(null)
    try {
      await work()
      refresh()
      toast({ title: done })
      if (action === "delete") onClose()
      else load()
    } catch (e) {
      setError(e instanceof Error ? e.message : "That did not work")
    } finally {
      setBusy(null)
    }
  }

  async function tryRelease(candidateId: string) {
    setTryingId(candidateId)
    await run("retry", () => retryDownload(downloadId, candidateId), "Trying that release first")
    setTryingId(null)
  }

  if (!detail) {
    return (
      <div className="p-5 md:p-7">
        {error ? <p className="text-[0.9375rem] text-bad">{error}</p> : <BodySkeleton />}
      </div>
    )
  }

  const title = card?.title ?? "Download"
  const attempt = detail.activeAttempt

  return (
    <div className="p-5 pt-7 md:p-7">
      {/* Identity */}
      <div className="flex items-start gap-4">
        <Poster path={card?.posterPath} title={title} size="poster" className="w-20 shrink-0 shadow-lift md:w-24" />
        <div className="min-w-0 flex-1 pt-1">
          <StatusLabel status={DOWNLOAD_STATUS[detail.status]} variant="filled" />
          <h2 className="display mt-2.5 text-[2rem] text-ink [overflow-wrap:anywhere] md:text-[2.5rem]">{title}</h2>
          <p className="mt-1.5 text-[0.8125rem] text-ink-2">
            {detail.season !== null && <span className="font-semibold text-ink">Season {detail.season}. </span>}
            {detail.run > 1 && <span>Run {detail.run}. </span>}
            Updated {formatRelativeTime(detail.updatedAt)}
          </p>
        </div>
        <SheetClose className="-mr-2 -mt-2" />
      </div>

      {/* Live progress */}
      <AnimatePresence initial={false}>
        {running && (
          <motion.section
            initial={{ opacity: 0, height: 0 }}
            animate={{ opacity: 1, height: "auto" }}
            exit={{ opacity: 0, height: 0 }}
            transition={FADE}
            aria-label="Progress"
            className="overflow-hidden"
          >
            <div className="mt-6 rounded-panel bg-paper p-4 shadow-ring">
              <div className="flex items-end justify-between gap-4">
                <p className="text-sm font-semibold text-ink">
                  {attempt?.episodeNumber != null && detail.season !== null && <span className="mr-2 font-mono text-ink-2">{episodeCode(detail.season, attempt.episodeNumber)}</span>}
                  {attempt ? ATTEMPT_PHASE[attempt.phase] : DOWNLOAD_STATUS[detail.status].label}
                </p>
                <span className="display text-4xl text-ink tabular">{attempt ? formatPercent(attempt.progress) : "..."}</span>
              </div>
              <ProgressBar value={attempt?.progress} label="Download progress" size="md" className="mt-3" />
              <PhaseSteps phase={attempt?.phase ?? null} className="mt-4" />
              {attempt && <p className="mt-3 truncate font-mono text-micro text-ink-3" title={attempt.candidateTitle}>{attempt.candidateTitle}</p>}
            </div>
          </motion.section>
        )}
      </AnimatePresence>

      {detail.statusMessage && !running && <p className="mt-5 text-[0.9375rem] leading-relaxed text-ink-2">{detail.statusMessage}</p>}

      {/* Actions */}
      <div className="mt-5 flex flex-wrap items-center gap-2">
        {running && (
          <Button variant="outline" icon={ProhibitIcon} loading={busy === "cancel"} disabled={busy !== null} onClick={() => run("cancel", () => cancelDownload(downloadId), "Download cancelled")}>
            Cancel
          </Button>
        )}
        {!running && detail.status !== "completed" && (
          <Button variant="signal" icon={ArrowsClockwiseIcon} loading={busy === "retry" && !tryingId} disabled={busy !== null} onClick={() => run("retry", () => retryDownload(downloadId), "Retrying")}>
            Retry
          </Button>
        )}
        <Button variant="ghost" iconEnd={ArrowRightIcon} onClick={() => { onClose(); onOpenTitle({ mediaType: detail.mediaType, id: detail.tmdbId }) }}>
          View title
        </Button>
        <span className="ml-auto">
          {confirmDelete ? (
            <span className="inline-flex items-center gap-1">
              <Button variant="ghost" size="sm" onClick={() => setConfirmDelete(false)}>Keep</Button>
              <Button variant="danger" size="sm" icon={TrashIcon} loading={busy === "delete"} onClick={() => run("delete", () => deleteDownload(downloadId), "Download removed")}>
                Remove for good
              </Button>
            </span>
          ) : (
            <Button variant="danger" size="sm" icon={TrashIcon} disabled={busy !== null} onClick={() => setConfirmDelete(true)}>
              Remove
            </Button>
          )}
        </span>
      </div>
      {confirmDelete && <p className="mt-2 text-right text-micro text-ink-2">Removes this download and its history. Library files are kept.</p>}
      {error && <p role="alert" className="mt-3 text-[0.875rem] font-medium text-bad">{error}</p>}

      {detail.result && detail.result.files.length > 0 && (
        <Section title="Saved to the library" count={detail.result.files.length}>
          <ul className="space-y-1 rounded-[0.875rem] bg-paper p-3 shadow-ring">
            {detail.result.files.map((file) => (
              <li key={file} className="truncate font-mono text-micro text-ink-2" title={file}>
                {file}
              </li>
            ))}
          </ul>
        </Section>
      )}

      {detail.episodes.length > 0 && (
        <Section title="Episodes" count={detail.episodes.length}>
          <EpisodeCells episodes={detail.episodes} />
        </Section>
      )}

      <Section title="Attempts" count={detail.attempts.length}>
        <AttemptTimeline attempts={detail.attempts} candidates={detail.candidates} episodes={detail.episodes} />
      </Section>

      <Section title="Releases" count={detail.candidates.length}>
        {!running && detail.candidates.length > 0 && <p className="mb-3 text-[0.875rem] text-ink-2">Pick a release to try it first on the next run.</p>}
        <ReleaseGroups detail={detail} onTry={running ? undefined : tryRelease} tryingId={tryingId} />
      </Section>
    </div>
  )
}

/* -------------------------------------------------------------------------- */
/* Scoped components                                                          */
/* -------------------------------------------------------------------------- */

interface SectionProps {
  title: string
  count?: number
  children: React.ReactNode
}

function Section({ title, count, children }: SectionProps) {
  return (
    <section className="mt-9">
      <h3 className="heading mb-3 flex items-baseline gap-2 text-lg text-ink">
        {title}
        {count !== undefined && <span className="font-mono text-sm font-medium text-ink-3 tabular">{count}</span>}
      </h3>
      {children}
    </section>
  )
}

/** Each episode of a season as a numbered cell in its state's colour. */
function EpisodeCells({ episodes }: { episodes: EpisodeRecord[] }) {
  return (
    <ul className="grid grid-cols-[repeat(auto-fill,minmax(3.25rem,1fr))] gap-1.5">
      {episodes.map((episode, index) => {
        const status = EPISODE_STATUS[episode.status]
        return (
          <motion.li
            key={episode.id}
            initial={{ opacity: 0, scale: 0.9 }}
            animate={{ opacity: 1, scale: 1 }}
            transition={{ ...FADE, delay: staggerDelay(index) }}
            title={`Episode ${episode.episodeNumber}: ${status.label}${episode.statusMessage ? `. ${episode.statusMessage}` : ""}`}
            className={cn("flex h-11 flex-col items-center justify-center rounded-[0.625rem] font-mono text-micro font-semibold tabular", TONE_FILL[status.tone], status.animated && "animate-pulse")}
          >
            E{String(episode.episodeNumber).padStart(2, "0")}
            <span className="sr-only">, {status.label}</span>
          </motion.li>
        )
      })}
    </ul>
  )
}

interface AttemptTimelineProps {
  attempts: AttemptRecord[]
  candidates: CandidateRecord[]
  episodes: EpisodeRecord[]
}

/** Every try, newest first, threaded on a line, with why each one ended. */
function AttemptTimeline({ attempts, candidates, episodes }: AttemptTimelineProps) {
  if (attempts.length === 0) return <p className="text-[0.9375rem] text-ink-2">Nothing has been tried yet.</p>

  const titles = new Map(candidates.map((candidate) => [candidate.id, candidate.title]))
  const numbers = new Map(episodes.map((episode) => [episode.id, episode.episodeNumber]))

  return (
    <ol className="relative ml-1.5 border-l border-line-strong pl-5">
      {attempts.map((attempt) => {
        const episode = attempt.episodeId ? numbers.get(attempt.episodeId) : undefined
        const outcome = attempt.outcome ? ATTEMPT_OUTCOME[attempt.outcome] : null
        return (
          <li key={attempt.id} className="relative pb-5 last:pb-0">
            <span
              aria-hidden
              className={cn(
                "absolute -left-[1.6875rem] top-1 size-3 rounded-full ring-4 ring-surface",
                !outcome ? "bg-signal" : outcome.tone === "ok" ? "bg-ok" : outcome.tone === "bad" ? "bg-bad" : "bg-line-strong",
              )}
            />
            <div className="flex items-start justify-between gap-3">
              <p className="min-w-0 flex-1 break-all font-mono text-[0.8125rem] leading-snug text-ink">
                {episode !== undefined && <span className="mr-1.5 text-ink-3">E{String(episode).padStart(2, "0")}</span>}
                {titles.get(attempt.candidateId) ?? "Unknown release"}
              </p>
              {outcome ? <StatusLabel status={outcome} className="shrink-0 text-micro" /> : <span className="shrink-0 text-micro font-semibold text-ink">{ATTEMPT_PHASE[attempt.phase]}</span>}
            </div>
            {attempt.reason && <p className="mt-1 text-[0.8125rem] font-medium text-bad">{attempt.reason}</p>}
            <p className="mt-1 text-micro text-ink-3">
              Run {attempt.run}, started {formatRelativeTime(attempt.startedAt)}
            </p>
          </li>
        )
      })}
    </ol>
  )
}

interface ReleaseGroupsProps {
  detail: DownloadDetail
  onTry?: (candidateId: string) => void
  tryingId: string | null
}

/** Releases by unit: the movie or season packs first, then each episode's. */
function ReleaseGroups({ detail, onTry, tryingId }: ReleaseGroupsProps) {
  const main = detail.candidates.filter((candidate) => candidate.episodeId === null)
  const perEpisode = detail.episodes
    .map((episode) => ({ episode, list: detail.candidates.filter((candidate) => candidate.episodeId === episode.id) }))
    .filter((group) => group.list.length > 0)

  return (
    <div className="space-y-6">
      {(main.length > 0 || perEpisode.length === 0) && (
        <div>
          {detail.season !== null && <p className="mb-2 text-micro font-semibold text-ink-3">Season packs</p>}
          <ReleaseList candidates={main} onTry={onTry} tryingId={tryingId} />
        </div>
      )}
      {perEpisode.map(({ episode, list }) => (
        <div key={episode.id}>
          <p className="mb-2 font-mono text-micro font-semibold text-ink-3">{episodeCode(detail.season ?? 0, episode.episodeNumber)}</p>
          <ReleaseList candidates={list} onTry={onTry} tryingId={tryingId} initialCount={3} />
        </div>
      ))}
    </div>
  )
}

function BodySkeleton() {
  return (
    <div>
      <div className="flex gap-4">
        <Skeleton className="aspect-[2/3] w-20 md:w-24" />
        <div className="flex-1 space-y-3 pt-1">
          <Skeleton className="h-7 w-24 rounded-full" />
          <Skeleton className="h-9 w-3/4 rounded-full" />
          <Skeleton className="h-3 w-1/3 rounded-full" />
        </div>
      </div>
      <Skeleton className="mt-6 h-32 w-full rounded-panel" />
      <Skeleton className="mt-6 h-24 w-full rounded-panel" />
    </div>
  )
}
