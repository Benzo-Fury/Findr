import * as React from "react"
import {
  Ban,
  CheckCircle2,
  Clock,
  ListTodo,
  Loader2,
  Save,
  Scale,
  Search,
  Trash2,
  XCircle,
  Zap,
} from "lucide-react"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Skeleton } from "@/components/ui/skeleton"
import { fetchJobs, deleteJob } from "@/lib/api"
import { useTMDBMeta } from "@/lib/hooks"
import type { Job, JobStage, TMDBMeta } from "@/lib/types"
import { cn } from "@/lib/utils"

/**
 * The job pipeline, as a table on desktop and cards on mobile.
 *
 * Jobs store only the IMDb ID they were queued with, so every title and poster
 * on this page is resolved from TMDB after the fact.
 */

const POSTER_BASE = "https://image.tmdb.org/t/p/w92"

/** How often to re-read the list while any job is still moving. */
const POLL_INTERVAL = 5000

/** Stages a job never leaves. Only these can be dismissed. */
const TERMINAL_STAGES: JobStage[] = ["completed", "failed", "cancelled"]

type FilterValue = "all" | JobStage

interface StageConfig {
  label: string
  icon: typeof Clock
  variant: "default" | "info" | "purple" | "warning" | "success" | "destructive" | "secondary" | "outline"
  /** Pulses the icon while the stage is one the pipeline actively works in. */
  animated?: boolean
}

/** How each pipeline stage is presented. Mirrors the API's `JobStatus`. */
const STAGE_CONFIG: Record<JobStage, StageConfig> = {
  pending: { label: "Pending", icon: Clock, variant: "secondary" },
  querying: { label: "Querying", icon: Search, variant: "info", animated: true },
  deciding: { label: "Deciding", icon: Scale, variant: "default", animated: true },
  sterilizing: { label: "Sterilizing", icon: Zap, variant: "warning", animated: true },
  saving: { label: "Saving", icon: Save, variant: "purple", animated: true },
  completed: { label: "Completed", icon: CheckCircle2, variant: "success" },
  failed: { label: "Failed", icon: XCircle, variant: "destructive" },
  cancelled: { label: "Cancelled", icon: Ban, variant: "outline" },
}

const FILTERS: { value: FilterValue; label: string }[] = [
  { value: "all", label: "All Jobs" },
  { value: "pending", label: "Pending" },
  { value: "querying", label: "Querying" },
  { value: "deciding", label: "Deciding" },
  { value: "sterilizing", label: "Sterilizing" },
  { value: "saving", label: "Saving" },
  { value: "completed", label: "Completed" },
  { value: "failed", label: "Failed" },
  { value: "cancelled", label: "Cancelled" },
]

export function JobsPage() {
  const [jobs, setJobs] = React.useState<Job[]>([])
  const [loading, setLoading] = React.useState(true)
  const [filter, setFilter] = React.useState<FilterValue>("all")
  const [deletingId, setDeletingId] = React.useState<string | null>(null)
  const { meta, loadingIds, fetchMeta } = useTMDBMeta()

  const loadJobs = React.useCallback(() => {
    fetchJobs()
      .then(setJobs)
      .catch(() => {})
      .finally(() => setLoading(false))
  }, [])

  React.useEffect(() => {
    loadJobs()
  }, [loadJobs])

  // Poll only while something is still moving through the pipeline
  const hasActiveJobs = jobs.some((job) => !TERMINAL_STAGES.includes(job.status.primary))

  React.useEffect(() => {
    if (!hasActiveJobs) return
    const interval = setInterval(loadJobs, POLL_INTERVAL)
    return () => clearInterval(interval)
  }, [loadJobs, hasActiveJobs])

  React.useEffect(() => {
    const uniqueImdbIds = [...new Set(jobs.map((job) => job.imdbId))]
    uniqueImdbIds.forEach(fetchMeta)
  }, [jobs, fetchMeta])

  async function handleDelete(id: string) {
    setDeletingId(id)

    try {
      await deleteJob(id)
      setJobs((prev) => prev.filter((job) => job.id !== id))
    } catch {
      // The job was most likely already removed — the next poll will agree
    }

    setDeletingId(null)
  }

  const filteredJobs =
    filter === "all" ? jobs : jobs.filter((job) => job.status.primary === filter)

  const activeCount = jobs.filter(
    (job) => !TERMINAL_STAGES.includes(job.status.primary) && job.status.primary !== "pending",
  ).length
  const completedCount = jobs.filter((job) => job.status.primary === "completed").length
  const failedCount = jobs.filter((job) => job.status.primary === "failed").length

  return (
    <div className="mx-auto max-w-[1600px] px-4 py-6 lg:px-6 lg:py-8">
      <div className="mb-6 grid grid-cols-2 gap-3 sm:grid-cols-4 lg:gap-4">
        <StatCard label="Total" value={jobs.length} icon={ListTodo} color="text-foreground" />
        <StatCard label="In Progress" value={activeCount} icon={Zap} color="text-blue-500" />
        <StatCard
          label="Completed"
          value={completedCount}
          icon={CheckCircle2}
          color="text-emerald-500"
        />
        <StatCard label="Failed" value={failedCount} icon={XCircle} color="text-destructive" />
      </div>

      <div className="mb-4 flex flex-wrap gap-1.5 lg:gap-2">
        {FILTERS.map(({ value, label }) => (
          <button
            key={value}
            onClick={() => setFilter(value)}
            className={cn(
              "rounded-lg px-3 py-1.5 text-xs font-medium transition-colors lg:px-4 lg:py-2 lg:text-sm",
              filter === value
                ? "bg-ring text-white"
                : "bg-muted text-muted-foreground hover:text-foreground",
            )}
          >
            {label}
            {value === "all" && ` (${jobs.length})`}
          </button>
        ))}
      </div>

      {loading ? (
        <div className="space-y-3">
          {Array.from({ length: 8 }).map((_, i) => (
            <Skeleton key={i} className="h-16 rounded-lg" />
          ))}
        </div>
      ) : filteredJobs.length === 0 ? (
        <div className="flex flex-col items-center justify-center py-20 text-center">
          <ListTodo className="mb-4 size-12 text-muted-foreground/50" />
          <h2 className="mb-1 text-lg font-medium">No jobs</h2>
          <p className="text-sm text-muted-foreground">
            {filter === "all"
              ? "Search for something to start a job."
              : "No jobs match this filter."}
          </p>
        </div>
      ) : (
        <>
          <div className="hidden md:block">
            <div className="rounded-xl border">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b bg-muted/30">
                    <th className="px-4 py-2.5 text-left font-medium text-muted-foreground">
                      Media
                    </th>
                    <th className="px-4 py-2.5 text-left font-medium text-muted-foreground">
                      Status
                    </th>
                    <th className="px-4 py-2.5 text-left font-medium text-muted-foreground">
                      Message
                    </th>
                    <th className="px-4 py-2.5 text-left font-medium text-muted-foreground">
                      Updated
                    </th>
                    <th className="w-10" />
                  </tr>
                </thead>
                <tbody>
                  {filteredJobs.map((job) => (
                    <JobRow
                      key={job.id}
                      job={job}
                      meta={meta[job.imdbId]}
                      metaLoading={loadingIds.has(job.imdbId)}
                      deleting={deletingId === job.id}
                      onDelete={() => handleDelete(job.id)}
                    />
                  ))}
                </tbody>
              </table>
            </div>
          </div>

          <div className="space-y-3 md:hidden">
            {filteredJobs.map((job) => (
              <JobCard
                key={job.id}
                job={job}
                meta={meta[job.imdbId]}
                metaLoading={loadingIds.has(job.imdbId)}
                deleting={deletingId === job.id}
                onDelete={() => handleDelete(job.id)}
              />
            ))}
          </div>
        </>
      )}
    </div>
  )
}

/* -------------------------------------------------------------------------- */
/* Scoped components                                                          */
/* -------------------------------------------------------------------------- */

interface StatCardProps {
  label: string
  value: number
  icon: typeof Clock
  color: string
}

function StatCard({ label, value, icon: Icon, color }: StatCardProps) {
  return (
    <div className="rounded-xl border bg-card p-4 lg:p-5">
      <div className="flex items-center gap-2">
        <Icon className={cn("size-4 lg:size-5", color)} />
        <span className="text-xs font-medium tracking-wide text-muted-foreground uppercase lg:text-sm">
          {label}
        </span>
      </div>
      <p className="mt-1 text-2xl font-bold lg:text-3xl">{value}</p>
    </div>
  )
}

interface JobItemProps {
  job: Job
  meta?: TMDBMeta
  metaLoading: boolean
  deleting: boolean
  onDelete: () => void
}

/** The season suffix shown under a title, for shows only. */
function seasonLabel(season: number | null): string {
  return season === null ? "" : ` - S${String(season).padStart(2, "0")}`
}

function StageBadge({ job, className }: { job: Job; className?: string }) {
  const config = STAGE_CONFIG[job.status.primary]
  const Icon = config.icon

  return (
    <Badge variant={config.variant} className={cn("gap-1", className)}>
      <Icon className={cn("size-3", config.animated && "animate-pulse")} />
      {config.label}
    </Badge>
  )
}

function JobRow({ job, meta, metaLoading, deleting, onDelete }: JobItemProps) {
  const canDelete = TERMINAL_STAGES.includes(job.status.primary)
  const isFailed = job.status.primary === "failed"

  return (
    <tr
      className={cn(
        "group border-b transition-colors last:border-0",
        isFailed && "bg-destructive/5",
      )}
    >
      <td className="px-4 py-3">
        <div className="flex items-center gap-3">
          {metaLoading ? (
            <Skeleton className="size-10 rounded" />
          ) : meta?.posterPath ? (
            <img
              src={`${POSTER_BASE}${meta.posterPath}`}
              alt={meta.title}
              className="size-10 rounded object-cover"
            />
          ) : (
            <div className="size-10 rounded bg-muted" />
          )}

          <div className="min-w-0">
            {metaLoading ? (
              <>
                <Skeleton className="mb-1 h-4 w-32" />
                <Skeleton className="h-3 w-20" />
              </>
            ) : (
              <>
                <p className="truncate font-medium">{meta?.title || job.imdbId}</p>
                <p className="text-xs text-muted-foreground">
                  {job.imdbId}
                  {seasonLabel(job.season)}
                </p>
              </>
            )}
          </div>
        </div>
      </td>

      <td className="px-4 py-3">
        <StageBadge job={job} />
      </td>

      <td className="px-4 py-3">
        <p className="max-w-xs truncate text-sm text-muted-foreground">
          {job.status.message || "-"}
        </p>
      </td>

      <td className="px-4 py-3 text-xs text-muted-foreground">
        {formatRelativeTime(job.updatedAt)}
      </td>

      <td className="px-4 py-3">
        {canDelete && (
          <Button
            variant="ghost"
            size="icon-xs"
            className="text-muted-foreground opacity-0 group-hover:opacity-100 hover:text-destructive"
            onClick={onDelete}
            disabled={deleting}
          >
            {deleting ? (
              <Loader2 className="size-3 animate-spin" />
            ) : (
              <Trash2 className="size-3" />
            )}
          </Button>
        )}
      </td>
    </tr>
  )
}

function JobCard({ job, meta, metaLoading, deleting, onDelete }: JobItemProps) {
  const canDelete = TERMINAL_STAGES.includes(job.status.primary)
  const isFailed = job.status.primary === "failed"

  return (
    <div
      className={cn(
        "rounded-xl border bg-card p-4",
        isFailed && "border-destructive/30 bg-destructive/5",
      )}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="flex min-w-0 items-center gap-3">
          {metaLoading ? (
            <Skeleton className="size-12 shrink-0 rounded" />
          ) : meta?.posterPath ? (
            <img
              src={`${POSTER_BASE}${meta.posterPath}`}
              alt={meta.title}
              className="size-12 rounded object-cover"
            />
          ) : (
            <div className="size-12 shrink-0 rounded bg-muted" />
          )}

          <div className="min-w-0">
            {metaLoading ? (
              <>
                <Skeleton className="mb-1 h-4 w-28" />
                <Skeleton className="h-3 w-16" />
              </>
            ) : (
              <>
                <p className="truncate text-sm font-medium">{meta?.title || job.imdbId}</p>
                <p className="text-xs text-muted-foreground">
                  {job.imdbId}
                  {seasonLabel(job.season)}
                </p>
              </>
            )}
          </div>
        </div>

        <StageBadge job={job} className="shrink-0" />
      </div>

      {job.status.message && (
        <p className="mt-2 truncate text-xs text-muted-foreground">{job.status.message}</p>
      )}

      <div className="mt-2 flex items-center justify-between">
        <span className="text-xs text-muted-foreground">
          {formatRelativeTime(job.updatedAt)}
        </span>

        {canDelete && (
          <Button
            variant="ghost"
            size="icon-xs"
            className="text-muted-foreground hover:text-destructive"
            onClick={onDelete}
            disabled={deleting}
          >
            {deleting ? (
              <Loader2 className="size-3 animate-spin" />
            ) : (
              <Trash2 className="size-3" />
            )}
          </Button>
        )}
      </div>
    </div>
  )
}

/**
 * Renders a timestamp as an age. Accepts both epoch milliseconds and date
 * strings, since the API stores the former and may serialise either.
 */
function formatRelativeTime(value: string | number): string {
  const then = typeof value === "number" ? value : new Date(value).getTime()
  if (Number.isNaN(then)) return "-"

  const seconds = Math.floor((Date.now() - then) / 1000)
  if (seconds < 60) return "just now"

  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m ago`

  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h ago`

  return `${Math.floor(hours / 24)}d ago`
}
