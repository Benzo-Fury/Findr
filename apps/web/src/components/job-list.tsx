import { useState, useEffect } from "react"
import {
  Film,
  Tv,
  Clock,
  CheckCircle2,
  XCircle,
  Search,
  Zap,
  GitBranch,
  Trash2,
  ChevronLeft,
  ChevronRight,
  ChevronsUpDown,
  Layers,
  Activity,
  AlertCircle,
} from "lucide-react"
import { Skeleton } from "@/components/ui/skeleton"
import { StatCard } from "@/components/stat-card"
import { fetchTMDBByImdbId, type TMDBMeta } from "@/hooks/use-tmdb-search"

const TMDB_IMAGE = "https://image.tmdb.org/t/p/w200"

interface Job {
  id: string
  imdbId: string
  season: number | null
  status: { primary: string; message?: string }
  preferences?: {
    resolutions: string[]
    maxFileSizeGB: number
    minSeeders: number
    blacklistedReleaseTypes: string[]
  } | null
  createdAt: string
  updatedAt: string
}

type StatusKey = "pending" | "querying" | "deciding" | "sterilizing" | "completed" | "failed" | "cancelled"

const STATUS_CONFIG: Record<StatusKey, {
  icon: typeof Clock
  label: string
  bg: string
  text: string
  border: string
  barColor?: string
  animate?: boolean
}> = {
  pending: { icon: Clock, label: "Pending", bg: "bg-gray-100", text: "text-gray-600", border: "border-gray-200" },
  querying: { icon: Search, label: "Querying", bg: "bg-blue-50", text: "text-blue-600", border: "border-blue-200", barColor: "bg-blue-500", animate: true },
  deciding: { icon: GitBranch, label: "Deciding", bg: "bg-purple-50", text: "text-purple-600", border: "border-purple-200" },
  sterilizing: { icon: Zap, label: "Sterilizing", bg: "bg-amber-50", text: "text-amber-600", border: "border-amber-200", barColor: "bg-amber-500" },
  completed: { icon: CheckCircle2, label: "Completed", bg: "bg-green-50", text: "text-green-600", border: "border-green-200" },
  failed: { icon: XCircle, label: "Failed", bg: "bg-red-100", text: "text-red-600", border: "border-red-200" },
  cancelled: { icon: XCircle, label: "Cancelled", bg: "bg-gray-100", text: "text-gray-600", border: "border-gray-200" },
}

const FILTER_OPTIONS = [
  { key: "all", label: "All Jobs" },
  { key: "active", label: "Active", dot: "bg-blue-500" },
  { key: "pending", label: "Pending" },
  { key: "querying", label: "Querying" },
  { key: "sterilizing", label: "Sterilizing" },
  { key: "completed", label: "Completed" },
  { key: "failed", label: "Failed" },
]

const ACTIVE_STATUSES = new Set(["querying", "deciding", "sterilizing"])
const TERMINAL_STATUSES = new Set(["completed", "failed", "cancelled"])

function formatRelative(date: string): string {
  const diff = Date.now() - new Date(date).getTime()
  const mins = Math.floor(diff / 60000)
  if (mins < 1) return "Just now"
  if (mins < 60) return `${mins}m ago`
  const hours = Math.floor(mins / 60)
  if (hours < 24) return `${hours}h ago`
  return `${Math.floor(hours / 24)}d ago`
}

function formatTime(date: string): string {
  return new Date(date).toLocaleTimeString(undefined, {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
    timeZoneName: "short",
  })
}

function StatusBadge({ status }: { status: string }) {
  const config = STATUS_CONFIG[status as StatusKey] ?? STATUS_CONFIG.pending
  const Icon = config.icon
  return (
    <div className={`inline-flex items-center gap-1.5 ${config.bg} ${config.text} border ${config.border} px-2.5 py-1 rounded-md`}>
      <Icon className={`size-3.5 ${config.animate ? "animate-pulse" : ""}`} />
      <span className="text-[11px] font-bold uppercase tracking-widest">{config.label}</span>
    </div>
  )
}

function MediaCell({ job, meta }: { job: Job; meta: TMDBMeta | null }) {
  const isActive = ACTIVE_STATUSES.has(job.status.primary)
  const isCompleted = job.status.primary === "completed"
  const config = STATUS_CONFIG[job.status.primary as StatusKey]

  return (
    <div className="flex items-center gap-3">
      <div className={`w-10 h-14 rounded shrink-0 overflow-hidden border ${job.status.primary === "failed" ? "border-red-200" : "border-findr-border"} relative`}>
        {meta?.posterPath ? (
          <img
            src={`${TMDB_IMAGE}${meta.posterPath}`}
            alt=""
            className={`w-full h-full object-cover ${isCompleted ? "grayscale-[30%]" : ""}`}
          />
        ) : (
          <div className="w-full h-full bg-gray-100 flex items-center justify-center">
            {meta?.mediaType === "tv" || job.season !== null ? (
              <Tv className="size-5 text-gray-400" />
            ) : (
              <Film className="size-5 text-gray-400" />
            )}
          </div>
        )}
        {isActive && config?.barColor && (
          <div className="absolute bottom-0 left-0 right-0 h-1 bg-white/30">
            <div className={`h-full ${config.barColor} w-[65%]`} />
          </div>
        )}
      </div>
      <div className="min-w-0">
        <div className="font-extrabold text-sm text-findr-text truncate">
          {meta?.title ?? job.imdbId}
        </div>
        <div className="flex items-center gap-2 mt-0.5">
          {job.season !== null ? (
            <span className="text-[11px] font-bold text-findr-amber bg-findr-amber/10 px-1.5 rounded">
              S{String(job.season).padStart(2, "0")}
            </span>
          ) : (
            <span className="text-[11px] font-medium text-findr-secondary">
              {meta?.mediaType === "tv" ? "Series" : "Movie"}
            </span>
          )}
          <span className="w-1 h-1 rounded-full bg-findr-border" />
          <span className="font-mono text-[10px] text-findr-tertiary">{job.imdbId}</span>
        </div>
      </div>
    </div>
  )
}

function JobActions({ job, onDeleted }: { job: Job; onDeleted?: () => void }) {
  const isFailed = job.status.primary === "failed"

  if (!isFailed) return null

  async function handleDelete() {
    try {
      const res = await fetch(`/api/jobs/${job.id}/delete`, {
        method: "DELETE",
        credentials: "include",
      })
      if (res.ok) onDeleted?.()
    } catch {
      // silently fail
    }
  }

  return (
    <div className="flex gap-1">
      <button
        onClick={handleDelete}
        className="w-8 h-8 rounded hover:bg-red-50 text-findr-error flex items-center justify-center transition-colors"
        title="Delete Job"
      >
        <Trash2 className="size-[18px]" />
      </button>
    </div>
  )
}

function DesktopTable({ jobs, meta, onJobDeleted }: { jobs: Job[]; meta: Record<string, TMDBMeta>; onJobDeleted?: () => void }) {
  return (
    <div className="hidden md:block bg-white border border-findr-border rounded-xl shadow-sm overflow-hidden">
      <div className="overflow-x-auto">
        <table className="w-full text-left border-collapse">
          <thead>
            <tr className="bg-findr-bg border-b border-findr-border">
              <th className="py-3 px-5 text-xs font-bold text-findr-secondary uppercase tracking-wider w-[25%]">
                <div className="flex items-center gap-1">Media <ChevronsUpDown className="size-3.5 opacity-50" /></div>
              </th>
              <th className="py-3 px-5 text-xs font-bold text-findr-secondary uppercase tracking-wider">
                <div className="flex items-center gap-1">Status <ChevronsUpDown className="size-3.5 opacity-50" /></div>
              </th>
              <th className="py-3 px-5 text-xs font-bold text-findr-secondary uppercase tracking-wider w-[30%]">
                Message & Progress
              </th>
              <th className="py-3 px-5 text-xs font-bold text-findr-secondary uppercase tracking-wider">
                <div className="flex items-center gap-1">Updated <ChevronsUpDown className="size-3.5 opacity-50" /></div>
              </th>
              <th className="py-3 px-5 text-xs font-bold text-findr-secondary uppercase tracking-wider text-right">
                Actions
              </th>
            </tr>
          </thead>
          <tbody className="divide-y divide-findr-border">
            {jobs.map((job) => {
              const config = STATUS_CONFIG[job.status.primary as StatusKey] ?? STATUS_CONFIG.pending
              const isActive = ACTIVE_STATUSES.has(job.status.primary)
              const isCompleted = job.status.primary === "completed"
              const isFailed = job.status.primary === "failed"
              const isPending = job.status.primary === "pending"
              const m = meta[job.imdbId] ?? null

              return (
                <tr
                  key={job.id}
                  className={`hover:bg-findr-hover transition-colors group ${
                    isFailed ? "bg-red-50/30" : ""
                  } ${isCompleted || isPending ? "opacity-80 hover:opacity-100" : ""}`}
                >
                  <td className="py-3 px-5">
                    <MediaCell job={job} meta={m} />
                  </td>
                  <td className="py-3 px-5">
                    <StatusBadge status={job.status.primary} />
                  </td>
                  <td className="py-3 px-5">
                    <div className="flex flex-col gap-1.5">
                      <span className={`text-[13px] font-medium truncate ${
                        isFailed ? "text-red-600" : isCompleted ? "text-findr-secondary" : "text-findr-text"
                      }`}>
                        {job.status.message ?? (isPending ? "Waiting in queue..." : "")}
                      </span>
                      {isActive && config.barColor && (
                        <div className="flex items-center gap-2 w-full max-w-[200px]">
                          <div className="h-1.5 flex-1 bg-gray-200 rounded-full overflow-hidden">
                            <div className={`h-full ${config.barColor} rounded-full ${config.animate ? "animate-pulse w-[20%]" : "progress-striped w-[65%]"}`} />
                          </div>
                          {!config.animate && (
                            <span className={`font-mono text-[10px] font-bold ${config.text}`}>65%</span>
                          )}
                        </div>
                      )}
                    </div>
                  </td>
                  <td className="py-3 px-5">
                    <div className="flex flex-col">
                      <span className={`text-[13px] font-medium ${isCompleted ? "text-findr-secondary" : "text-findr-text"}`}>
                        {formatRelative(job.updatedAt)}
                      </span>
                      <span className="font-mono text-[10px] text-findr-tertiary">
                        {formatTime(job.updatedAt)}
                      </span>
                    </div>
                  </td>
                  <td className="py-3 px-5 text-right">
                    <div className="flex justify-end opacity-0 group-hover:opacity-100 transition-opacity">
                      <JobActions job={job} onDeleted={onJobDeleted} />
                    </div>
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>

      {jobs.length > 0 && (
        <div className="px-6 py-4 border-t border-findr-border bg-gray-50/50 flex items-center justify-between">
          <span className="text-sm text-findr-secondary">
            Showing <span className="font-bold text-findr-text">1-{jobs.length}</span> of <span className="font-bold text-findr-text">{jobs.length}</span> jobs
          </span>
          <div className="flex gap-1">
            <button className="w-8 h-8 flex items-center justify-center rounded border border-findr-border bg-white text-findr-tertiary cursor-not-allowed" disabled>
              <ChevronLeft className="size-4" />
            </button>
            <button className="w-8 h-8 flex items-center justify-center rounded border border-findr-border bg-white text-findr-text text-xs font-bold">
              1
            </button>
            <button className="w-8 h-8 flex items-center justify-center rounded border border-findr-border bg-white text-findr-tertiary cursor-not-allowed" disabled>
              <ChevronRight className="size-4" />
            </button>
          </div>
        </div>
      )}
    </div>
  )
}

function MobileCard({ job, meta, onJobDeleted }: { job: Job; meta: TMDBMeta | null; onJobDeleted?: () => void }) {
  const config = STATUS_CONFIG[job.status.primary as StatusKey] ?? STATUS_CONFIG.pending
  const isActive = ACTIVE_STATUSES.has(job.status.primary)
  const isFailed = job.status.primary === "failed"

  return (
    <div className={`bg-white rounded-xl border ${isFailed ? "border-red-200 bg-red-50/10" : "border-findr-border"} p-4 shadow-sm relative overflow-hidden`}>
      {isActive && config.barColor && (
        <div className="absolute top-0 left-0 right-0 h-1 bg-gray-100">
          <div className={`h-full ${config.barColor} ${config.animate ? "animate-pulse w-[20%]" : "progress-striped w-[65%]"}`} />
        </div>
      )}

      <div className={`flex justify-between items-start mb-3 ${isActive ? "mt-1" : ""}`}>
        <div className="min-w-0 pr-3">
          <h3 className="font-extrabold text-base text-findr-text leading-tight mb-1 truncate">
            {meta?.title ?? job.imdbId}
          </h3>
          <div className="flex items-center gap-2">
            {job.season !== null ? (
              <span className="text-[11px] font-bold text-findr-amber bg-findr-amber/10 px-1 rounded">
                S{String(job.season).padStart(2, "0")}
              </span>
            ) : (
              <span className="text-[11px] font-medium text-findr-secondary">
                {meta?.mediaType === "tv" ? "Series" : "Movie"}
              </span>
            )}
            <span className="font-mono text-[10px] text-findr-tertiary">{job.imdbId}</span>
          </div>
        </div>
        <StatusBadge status={job.status.primary} />
      </div>

      {(job.status.message || job.status.primary === "pending") && (
        <div className={`rounded-lg p-3 mb-4 ${isFailed ? "bg-red-50 border border-red-100" : "bg-gray-50"}`}>
          <p className={`text-xs font-medium leading-snug ${isFailed ? "text-red-600" : "text-findr-text"}`}>
            {job.status.message ?? "Waiting in queue..."}
          </p>
          {isActive && config.barColor && !config.animate && (
            <div className="flex items-center justify-between mt-2 pt-2 border-t border-gray-200">
              <span className="text-[11px] text-findr-secondary">Progress</span>
              <span className={`font-mono text-[11px] font-bold ${config.text}`}>65%</span>
            </div>
          )}
        </div>
      )}

      <div className="flex items-center justify-between mt-auto pt-2">
        <span className="text-[11px] text-findr-secondary font-medium">
          Updated: {formatRelative(job.updatedAt)}
        </span>
        <div className="flex gap-2">
          <JobActions job={job} onDeleted={onJobDeleted} />
        </div>
      </div>
    </div>
  )
}

function MobileList({ jobs, meta, onJobDeleted }: { jobs: Job[]; meta: Record<string, TMDBMeta>; onJobDeleted?: () => void }) {
  return (
    <div className="md:hidden flex flex-col gap-4">
      {jobs.map((job) => (
        <MobileCard key={job.id} job={job} meta={meta[job.imdbId] ?? null} onJobDeleted={onJobDeleted} />
      ))}
    </div>
  )
}

export function JobList({ jobs, loading, onJobDeleted }: { jobs: Job[]; loading: boolean; onJobDeleted?: () => void }) {
  const [filter, setFilter] = useState("all")
  const [meta, setMeta] = useState<Record<string, TMDBMeta>>({})

  useEffect(() => {
    const unknownIds = [...new Set(jobs.map((j) => j.imdbId))].filter((id) => !meta[id])
    if (unknownIds.length === 0) return

    Promise.all(
      unknownIds.map(async (id) => {
        const m = await fetchTMDBByImdbId(id)
        if (m) setMeta((prev) => ({ ...prev, [id]: m }))
      })
    )
  }, [jobs]) // eslint-disable-line react-hooks/exhaustive-deps

  const filteredJobs = jobs.filter((job) => {
    if (filter === "all") return true
    if (filter === "active") return ACTIVE_STATUSES.has(job.status.primary)
    return job.status.primary === filter
  })

  const totalCount = jobs.length
  const activeCount = jobs.filter((j) => ACTIVE_STATUSES.has(j.status.primary)).length
  const completedCount = jobs.filter((j) => j.status.primary === "completed").length
  const failedCount = jobs.filter((j) => j.status.primary === "failed").length

  if (loading) {
    return (
      <div className="space-y-6">
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3 md:gap-4">
          {Array.from({ length: 4 }).map((_, i) => (
            <Skeleton key={i} className="h-[88px] rounded-xl" />
          ))}
        </div>
        <div className="flex gap-2">
          {Array.from({ length: 5 }).map((_, i) => (
            <Skeleton key={i} className="h-8 w-20 rounded-full" />
          ))}
        </div>
        <div className="hidden md:block">
          <Skeleton className="h-[400px] rounded-xl" />
        </div>
        <div className="md:hidden space-y-4">
          {Array.from({ length: 3 }).map((_, i) => (
            <Skeleton key={i} className="h-[180px] rounded-xl" />
          ))}
        </div>
      </div>
    )
  }

  return (
    <div className="space-y-6">
      {/* Stats Grid */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3 md:gap-4">
        <StatCard icon={Layers} label="Total Jobs" value={totalCount} colorClass="text-findr-secondary" />
        <StatCard icon={Activity} label="In Progress" value={activeCount} colorClass="text-blue-600" />
        <StatCard icon={CheckCircle2} label="Completed" value={completedCount} colorClass="text-findr-success" />
        <StatCard icon={AlertCircle} label="Failed" value={failedCount} colorClass="text-findr-error" />
      </div>

      {/* Filter Chips */}
      <div className="flex items-center gap-2 overflow-x-auto pb-2 -mx-4 px-4 md:mx-0 md:px-0" style={{ scrollbarWidth: "none" }}>
        {FILTER_OPTIONS.map((opt) => (
          <button
            key={opt.key}
            onClick={() => setFilter(opt.key)}
            className={`px-4 py-1.5 rounded-full text-xs font-bold uppercase tracking-wide transition-colors whitespace-nowrap shrink-0 flex items-center gap-1.5 ${
              filter === opt.key
                ? "bg-findr-text text-white shadow-sm"
                : "bg-white border border-findr-border text-findr-secondary hover:text-findr-text hover:border-gray-300"
            }`}
          >
            {opt.dot && <div className={`w-2 h-2 rounded-full ${opt.dot}`} />}
            {opt.label}
          </button>
        ))}
      </div>

      {/* Empty State */}
      {filteredJobs.length === 0 && (
        <div className="flex flex-col items-center justify-center py-16 text-center">
          <Film className="size-10 text-findr-tertiary/40 mb-3" />
          <p className="text-sm font-medium text-findr-secondary">
            {filter === "all" ? "No jobs yet" : `No ${filter} jobs`}
          </p>
          {filter === "all" && (
            <p className="text-xs text-findr-tertiary mt-1">
              Search for a movie or series to get started
            </p>
          )}
        </div>
      )}

      {/* Table / Cards */}
      {filteredJobs.length > 0 && (
        <>
          <DesktopTable jobs={filteredJobs} meta={meta} onJobDeleted={onJobDeleted} />
          <MobileList jobs={filteredJobs} meta={meta} onJobDeleted={onJobDeleted} />
        </>
      )}
    </div>
  )
}
