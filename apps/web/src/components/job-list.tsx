import { Film, Tv, Clock, CheckCircle2, XCircle, Loader2, ExternalLink, HardDrive, Users, Ban } from "lucide-react"
import { Badge } from "@/components/ui/badge"
import { Card, CardContent } from "@/components/ui/card"
import { Skeleton } from "@/components/ui/skeleton"
import { Separator } from "@/components/ui/separator"

interface JobPreferences {
  resolutions: string[]
  maxFileSizeGB: number
  minSeeders: number
  blacklistedReleaseTypes: string[]
}

interface Job {
  id: string
  imdbId: string
  season: number | null
  status: {
    primary: string
    message?: string
  }
  preferences?: JobPreferences | null
  createdAt: string
  updatedAt: string
}

const PIPELINE_STAGES = [
  { key: "pending", label: "Queued" },
  { key: "querying", label: "Searching" },
  { key: "deciding", label: "Scoring" },
  { key: "sterilizing", label: "Processing" },
  { key: "completed", label: "Done" },
]

const STATUS_CONFIG: Record<string, { icon: typeof Clock; label: string; variant: "default" | "secondary" | "destructive" | "outline" }> = {
  pending: { icon: Clock, label: "Pending", variant: "secondary" },
  querying: { icon: Loader2, label: "Searching", variant: "default" },
  deciding: { icon: Loader2, label: "Scoring", variant: "default" },
  sterilizing: { icon: Loader2, label: "Processing", variant: "default" },
  completed: { icon: CheckCircle2, label: "Completed", variant: "outline" },
  failed: { icon: XCircle, label: "Failed", variant: "destructive" },
  cancelled: { icon: XCircle, label: "Cancelled", variant: "secondary" },
}

function formatRelative(date: string): string {
  const diff = Date.now() - new Date(date).getTime()
  const mins = Math.floor(diff / 60000)
  if (mins < 1) return "just now"
  if (mins < 60) return `${mins}m ago`
  const hours = Math.floor(mins / 60)
  if (hours < 24) return `${hours}h ago`
  return `${Math.floor(hours / 24)}d ago`
}

function PipelineProgress({ status }: { status: string }) {
  const isFailed = status === "failed" || status === "cancelled"
  const currentIdx = PIPELINE_STAGES.findIndex(s => s.key === status)

  if (isFailed) {
    return (
      <div className="flex items-center gap-1.5 text-destructive">
        <XCircle className="size-3" />
        <span className="text-xs capitalize">{status}</span>
      </div>
    )
  }

  return (
    <div className="flex items-center gap-0">
      {PIPELINE_STAGES.map((stage, i) => {
        const isDone = i < currentIdx
        const isCurrent = i === currentIdx

        return (
          <div key={stage.key} className="flex items-center">
            <div className="flex flex-col items-center gap-1">
              <div className={`size-2 rounded-full transition-all ${
                isDone ? "bg-primary" :
                isCurrent ? "bg-primary ring-2 ring-primary/30" :
                "bg-muted-foreground/20"
              }`} />
              <span className={`text-[9px] leading-none whitespace-nowrap ${
                isDone || isCurrent ? "text-muted-foreground" : "text-muted-foreground/40"
              }`}>
                {stage.label}
              </span>
            </div>
            {i < PIPELINE_STAGES.length - 1 && (
              <div className={`h-px w-8 mb-3 mx-1 transition-colors ${
                i < currentIdx ? "bg-primary/40" : "bg-muted-foreground/15"
              }`} />
            )}
          </div>
        )
      })}
    </div>
  )
}

function PreferencesGrid({ prefs }: { prefs: JobPreferences }) {
  return (
    <div className="space-y-3">
      <p className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground/50">Preferences</p>
      <div className="grid grid-cols-2 gap-x-6 gap-y-3">
        <div className="space-y-1.5">
          <p className="text-[10px] uppercase tracking-wider text-muted-foreground/50">Resolution</p>
          <div className="flex flex-wrap gap-1">
            {prefs.resolutions.map(r => (
              <Badge key={r} variant="secondary" className="text-[10px] h-4 px-1.5 py-0">{r}</Badge>
            ))}
          </div>
        </div>

        <div className="space-y-1.5">
          <p className="text-[10px] uppercase tracking-wider text-muted-foreground/50 flex items-center gap-1">
            <HardDrive className="size-2.5" /> Max Size
          </p>
          <p className="text-xs font-medium">{prefs.maxFileSizeGB} GB</p>
        </div>

        <div className="space-y-1.5">
          <p className="text-[10px] uppercase tracking-wider text-muted-foreground/50 flex items-center gap-1">
            <Users className="size-2.5" /> Min Seeders
          </p>
          <p className="text-xs font-medium">{prefs.minSeeders}</p>
        </div>

        {prefs.blacklistedReleaseTypes.length > 0 && (
          <div className="space-y-1.5">
            <p className="text-[10px] uppercase tracking-wider text-muted-foreground/50 flex items-center gap-1">
              <Ban className="size-2.5" /> Blacklisted
            </p>
            <div className="flex flex-wrap gap-1">
              {prefs.blacklistedReleaseTypes.map(r => (
                <Badge key={r} variant="outline" className="text-[10px] h-4 px-1.5 py-0 text-muted-foreground">{r}</Badge>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  )
}

function JobCard({ job }: { job: Job }) {
  const config = STATUS_CONFIG[job.status.primary] ?? STATUS_CONFIG.pending
  const Icon = config.icon
  const isActive = ["querying", "deciding", "sterilizing"].includes(job.status.primary)
  const isTerminal = ["completed", "failed", "cancelled"].includes(job.status.primary)

  return (
    <Card className="overflow-hidden">
      <CardContent className="p-0">
        {/* Header */}
        <div className="flex items-start gap-3 p-4">
          <div className="flex size-9 shrink-0 items-center justify-center rounded-md bg-muted mt-0.5">
            {job.season !== null ? (
              <Tv className="size-4 text-muted-foreground" />
            ) : (
              <Film className="size-4 text-muted-foreground" />
            )}
          </div>

          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-1.5">
              <p className="font-semibold text-sm">{job.imdbId}</p>
              <a
                href={`https://www.imdb.com/title/${job.imdbId}`}
                target="_blank"
                rel="noopener noreferrer"
                className="text-muted-foreground/50 hover:text-muted-foreground transition-colors"
              >
                <ExternalLink className="size-3" />
              </a>
            </div>
            <div className="flex items-center gap-1.5 mt-0.5">
              <span className="text-xs text-muted-foreground">
                {job.season !== null ? `Season ${job.season}` : "Movie"}
              </span>
              <span className="text-muted-foreground/30 text-xs">·</span>
              <span className="text-xs text-muted-foreground">{formatRelative(job.createdAt)}</span>
              {isTerminal && (
                <>
                  <span className="text-muted-foreground/30 text-xs">·</span>
                  <span className="text-xs text-muted-foreground">finished {formatRelative(job.updatedAt)}</span>
                </>
              )}
            </div>
          </div>

          <Badge variant={config.variant} className="gap-1.5 shrink-0">
            <Icon className={`size-3 ${isActive ? "animate-spin" : ""}`} />
            {config.label}
          </Badge>
        </div>

        {/* Status message */}
        {job.status.message && (
          <>
            <Separator />
            <div className="px-4 py-2.5 bg-muted/30">
              <p className="text-xs text-muted-foreground">{job.status.message}</p>
            </div>
          </>
        )}

        <Separator />

        {/* Pipeline progress */}
        <div className="px-4 py-3">
          <PipelineProgress status={job.status.primary} />
        </div>

        {/* Preferences */}
        {job.preferences && (
          <>
            <Separator />
            <div className="px-4 py-3">
              <PreferencesGrid prefs={job.preferences} />
            </div>
          </>
        )}

        {/* Footer */}
        <Separator />
        <div className="flex items-center justify-between px-4 py-2 bg-muted/20">
          <span className="text-[10px] text-muted-foreground/50">
            {new Date(job.createdAt).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" })}
          </span>
          <span className="text-[10px] font-mono text-muted-foreground/40 select-all">{job.id.slice(0, 8)}</span>
        </div>
      </CardContent>
    </Card>
  )
}

export function JobList({ jobs, loading }: { jobs: Job[]; loading: boolean }) {
  if (loading) {
    return (
      <div className="space-y-3">
        {[...Array(3)].map((_, i) => (
          <Card key={i}>
            <CardContent className="p-4 space-y-4">
              <div className="flex items-center gap-3">
                <Skeleton className="size-9 rounded-md shrink-0" />
                <div className="flex-1 space-y-2">
                  <Skeleton className="h-4 w-28" />
                  <Skeleton className="h-3 w-20" />
                </div>
                <Skeleton className="h-6 w-20 rounded-full" />
              </div>
              <Skeleton className="h-px w-full" />
              <Skeleton className="h-8 w-full" />
            </CardContent>
          </Card>
        ))}
      </div>
    )
  }

  if (jobs.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center py-16 text-center">
        <Film className="size-10 text-muted-foreground/50 mb-3" />
        <p className="text-sm font-medium text-muted-foreground">No jobs yet</p>
        <p className="text-xs text-muted-foreground/70 mt-1">
          Search for a movie or series to get started
        </p>
      </div>
    )
  }

  return (
    <div className="space-y-3">
      {jobs.map((job) => (
        <JobCard key={job.id} job={job} />
      ))}
    </div>
  )
}
