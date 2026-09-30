import * as React from "react"
import { ListTodo } from "lucide-react"
import { useNavigate, useParams } from "react-router-dom"
import type { DownloadSummary } from "@findr/types/downloads"
import { fetchDownloads } from "@/lib/api"
import { ATTEMPT_PHASE, DOWNLOAD_STATUS, FINISHED_STATUSES } from "@/lib/download-status"
import { episodeCode, formatPercent, formatRelativeTime } from "@/lib/format"
import { tmdbKey, usePolling, useTMDBMeta } from "@/lib/hooks"
import type { TMDBMeta } from "@/lib/types"
import { cn } from "@/lib/utils"
import { DownloadDetailDialog } from "@/components/download-detail-dialog"
import { StatusBadge } from "@/components/status-badge"
import { Button } from "@/components/ui/button"
import { Progress } from "@/components/ui/progress"
import { Skeleton } from "@/components/ui/skeleton"

/**
 * Every download, newest activity first. Rows poll while anything is still
 * moving; opening one (`/downloads/:id`) shows its full detail.
 */

const POSTER_BASE = "https://image.tmdb.org/t/p/w92"
const POLL_INTERVAL = 3000
const PAGE_SIZE = 50

type Filter = "all" | "active" | "finished"

const FILTERS: { value: Filter; label: string }[] = [
  { value: "all", label: "All" },
  { value: "active", label: "In progress" },
  { value: "finished", label: "Finished" },
]

export function DownloadsPage() {
  const { id: openId } = useParams<{ id: string }>()
  const navigate = useNavigate()
  const [filter, setFilter] = React.useState<Filter>("all")
  const [items, setItems] = React.useState<DownloadSummary[]>([])
  const [total, setTotal] = React.useState(0)
  const [pages, setPages] = React.useState(1)
  const [loading, setLoading] = React.useState(true)
  const { meta, fetchMeta } = useTMDBMeta()

  // Re-read every loaded page so polling keeps the whole list fresh
  const load = React.useCallback(() => {
    fetchDownloads({ page: 1, pageSize: PAGE_SIZE * pages, state: filter === "all" ? undefined : filter })
      .then((page) => {
        setItems(page.items)
        setTotal(page.total)
      })
      .catch(() => {})
      .finally(() => setLoading(false))
  }, [filter, pages])

  React.useEffect(load, [load])

  const anyActive = items.some((item) => !FINISHED_STATUSES.includes(item.status))
  usePolling(load, anyActive, POLL_INTERVAL)

  React.useEffect(() => {
    for (const item of items) fetchMeta(item.mediaType, item.tmdbId)
  }, [items, fetchMeta])

  const open = items.find((item) => item.id === openId)

  return (
    <div className="mx-auto max-w-[1600px] px-4 py-6 lg:px-6 lg:py-8">
      <div className="mb-4 flex flex-wrap gap-1.5 lg:gap-2">
        {FILTERS.map(({ value, label }) => (
          <button
            key={value}
            onClick={() => {
              setFilter(value)
              setPages(1)
              setLoading(true)
            }}
            className={cn(
              "rounded-lg px-3 py-1.5 text-xs font-medium transition-colors lg:px-4 lg:py-2 lg:text-sm",
              filter === value ? "bg-ring text-white" : "bg-muted text-muted-foreground hover:text-foreground",
            )}
          >
            {label}
            {filter === value && !loading && ` (${total})`}
          </button>
        ))}
      </div>

      {loading ? (
        <div className="space-y-3">
          {Array.from({ length: 8 }).map((_, i) => (
            <Skeleton key={i} className="h-20 rounded-lg" />
          ))}
        </div>
      ) : items.length === 0 ? (
        <div className="flex flex-col items-center justify-center py-20 text-center">
          <ListTodo className="mb-4 size-12 text-muted-foreground/50" />
          <h2 className="mb-1 text-lg font-medium">No downloads</h2>
          <p className="text-sm text-muted-foreground">
            {filter === "all" ? "Find something on Discover to start a download." : "Nothing matches this filter."}
          </p>
        </div>
      ) : (
        <div className="space-y-2">
          {items.map((item) => (
            <DownloadRow
              key={item.id}
              download={item}
              meta={meta[tmdbKey(item.mediaType, item.tmdbId)]}
              onOpen={() => navigate(`/downloads/${item.id}`)}
            />
          ))}
          {items.length < total && (
            <div className="flex justify-center pt-2">
              <Button variant="outline" onClick={() => setPages((count) => count + 1)}>
                Load more
              </Button>
            </div>
          )}
        </div>
      )}

      {openId && (
        <DownloadDetailDialog
          downloadId={openId}
          meta={open ? meta[tmdbKey(open.mediaType, open.tmdbId)] : undefined}
          onClose={() => navigate("/downloads")}
          onChanged={load}
        />
      )}
    </div>
  )
}

/* -------------------------------------------------------------------------- */
/* Scoped components                                                          */
/* -------------------------------------------------------------------------- */

interface DownloadRowProps {
  download: DownloadSummary
  meta?: TMDBMeta
  onOpen: () => void
}

/** One download: artwork, title, status, and live progress when running. */
function DownloadRow({ download, meta, onOpen }: DownloadRowProps) {
  const active = download.activeAttempt
  const failed = download.status === "failed"

  return (
    <button
      onClick={onOpen}
      className={cn(
        "flex w-full items-center gap-3 rounded-lg border p-3 text-left transition-colors hover:bg-muted/50",
        failed && "bg-destructive/5",
      )}
    >
      {meta?.posterPath ? (
        <img src={`${POSTER_BASE}${meta.posterPath}`} alt="" className="h-14 w-10 shrink-0 rounded object-cover" />
      ) : (
        <div className="h-14 w-10 shrink-0 rounded bg-muted" />
      )}

      <div className="min-w-0 flex-1 space-y-1">
        <div className="flex items-center gap-2">
          <p className="truncate font-medium">
            {meta?.title ?? "Loading…"}
            {download.season !== null && (
              <span className="ml-1.5 text-sm font-normal text-muted-foreground">{episodeCode(download.season)}</span>
            )}
          </p>
        </div>

        {active ? (
          <div className="flex items-center gap-2">
            <Progress value={active.progress} className="max-w-xs" />
            <span className="shrink-0 text-xs text-muted-foreground">
              {active.episodeNumber !== null && download.season !== null && `${episodeCode(download.season, active.episodeNumber)} · `}
              {ATTEMPT_PHASE[active.phase]} {formatPercent(active.progress)}
            </span>
          </div>
        ) : (
          download.statusMessage && <p className="truncate text-xs text-muted-foreground">{download.statusMessage}</p>
        )}
      </div>

      <div className="flex shrink-0 flex-col items-end gap-1">
        <StatusBadge status={DOWNLOAD_STATUS[download.status]} />
        <span className="text-xs text-muted-foreground">{formatRelativeTime(download.updatedAt)}</span>
      </div>
    </button>
  )
}
