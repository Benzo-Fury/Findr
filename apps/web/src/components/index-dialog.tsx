import { useState } from "react"
import { Film, Tv, Download, CheckCircle2, Loader2 } from "lucide-react"
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Separator } from "@/components/ui/separator"
import type { IndexWithTorrents, Torrent } from "@findr/types"
import type { TMDBMeta } from "@/hooks/use-tmdb-search"

const TMDB_IMAGE = "https://image.tmdb.org/t/p/w342"

interface IndexDialogProps {
  index: IndexWithTorrents | null
  meta: TMDBMeta | null
  open: boolean
  onOpenChange: (open: boolean) => void
  onRedownloaded?: () => void
}

function formatSize(mb: number) {
  if (mb >= 1024) return `${(mb / 1024).toFixed(1)} GB`
  return `${mb} MB`
}

export function IndexDialog({ index, meta, open, onOpenChange, onRedownloaded }: IndexDialogProps) {
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [success, setSuccess] = useState(false)
  const [error, setError] = useState("")

  const currentSourceId = index?.sourceId ?? null
  const activeId = selectedId ?? currentSourceId

  async function handleDownload() {
    if (!index || !activeId) return
    setLoading(true)
    setError("")
    setSuccess(false)

    try {
      const res = await fetch(`/api/indexes/${index.id}/redownload`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ torrentId: activeId }),
      })

      if (!res.ok) {
        const data = await res.json().catch(() => null)
        throw new Error(data?.error ?? `Request failed (${res.status})`)
      }

      setSuccess(true)
      onRedownloaded?.()
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to queue download")
    } finally {
      setLoading(false)
    }
  }

  function handleOpenChange(v: boolean) {
    onOpenChange(v)
    if (!v) {
      setSelectedId(null)
      setSuccess(false)
      setError("")
    }
  }

  const torrents = index?.torrents ?? []

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="max-w-3xl p-0 overflow-hidden">
        <div className="flex h-full max-h-[80vh]">
          {/* Left: content info */}
          <div className="flex w-56 shrink-0 flex-col gap-4 overflow-y-auto p-5">
            <DialogHeader>
              <DialogTitle className="sr-only">{meta?.title ?? index?.imdbId}</DialogTitle>
            </DialogHeader>
            {meta?.posterPath ? (
              <img
                src={`${TMDB_IMAGE}${meta.posterPath}`}
                alt=""
                className="w-full rounded-md object-cover"
              />
            ) : (
              <div className="flex aspect-[2/3] w-full items-center justify-center rounded-md bg-muted">
                {meta?.mediaType === "tv" ? (
                  <Tv className="size-8 text-muted-foreground" />
                ) : (
                  <Film className="size-8 text-muted-foreground" />
                )}
              </div>
            )}
            <div className="space-y-1">
              <p className="font-semibold leading-tight">{meta?.title ?? index?.imdbId}</p>
              <div className="flex items-center gap-1.5">
                {meta?.year && <span className="text-xs text-muted-foreground">{meta.year}</span>}
                {index?.season != null && (
                  <Badge variant="secondary" className="text-[10px] px-1.5 py-0">
                    S{index.season}
                  </Badge>
                )}
                <Badge variant="outline" className="text-[10px] px-1.5 py-0">
                  {meta?.mediaType === "tv" ? "Series" : "Movie"}
                </Badge>
              </div>
              {meta?.overview && (
                <p className="text-xs text-muted-foreground leading-relaxed line-clamp-6">
                  {meta.overview}
                </p>
              )}
            </div>
          </div>

          <Separator orientation="vertical" />

          {/* Right: torrent list */}
          <div className="flex flex-1 flex-col overflow-hidden">
            <div className="flex items-center justify-between border-b px-4 py-3">
              <p className="text-sm font-medium">
                {torrents.length} torrent{torrents.length !== 1 ? "s" : ""}
              </p>
              <div className="flex items-center gap-2">
                {error && <p className="text-xs text-destructive">{error}</p>}
                {success && (
                  <span className="flex items-center gap-1 text-xs text-green-600">
                    <CheckCircle2 className="size-3" /> Queued
                  </span>
                )}
                <Button
                  size="sm"
                  onClick={handleDownload}
                  disabled={loading || !activeId}
                >
                  {loading ? (
                    <Loader2 className="size-3 animate-spin" />
                  ) : (
                    <Download className="size-3" />
                  )}
                  {activeId === currentSourceId && !selectedId ? "Re-download" : "Download"}
                </Button>
              </div>
            </div>

            <div className="flex-1 overflow-y-auto">
              {torrents.map((torrent) => (
                <TorrentRow
                  key={torrent.id}
                  torrent={torrent}
                  isSelected={torrent.id === activeId}
                  isSource={torrent.id === currentSourceId}
                  onClick={() => setSelectedId(torrent.id)}
                />
              ))}
            </div>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  )
}

function TorrentRow({
  torrent,
  isSelected,
  isSource,
  onClick,
}: {
  torrent: Torrent
  isSelected: boolean
  isSource: boolean
  onClick: () => void
}) {
  return (
    <button
      onClick={onClick}
      className={`flex w-full items-start gap-3 border-b px-4 py-3 text-left transition-colors hover:bg-accent ${
        isSelected ? "bg-accent" : ""
      }`}
    >
      <div className="flex-1 min-w-0 space-y-1">
        <p className="truncate text-xs font-medium">{torrent.title}</p>
        <div className="flex flex-wrap items-center gap-1.5">
          {torrent.resolution && (
            <Badge variant="secondary" className="text-[10px] h-4 px-1.5 py-0">
              {torrent.resolution}
            </Badge>
          )}
          {torrent.videoCodec && (
            <Badge variant="outline" className="text-[10px] h-4 px-1.5 py-0 text-muted-foreground">
              {torrent.videoCodec}
            </Badge>
          )}
          {torrent.releaseType && (
            <Badge variant="outline" className="text-[10px] h-4 px-1.5 py-0 text-muted-foreground">
              {torrent.releaseType}
            </Badge>
          )}
          {isSource && (
            <Badge className="text-[10px] h-4 px-1.5 py-0">
              current
            </Badge>
          )}
        </div>
      </div>
      <div className="shrink-0 text-right space-y-0.5">
        <p className="text-xs text-muted-foreground">{formatSize(torrent.sizeMB)}</p>
        <p className="text-[10px] text-muted-foreground">{torrent.seeders} seeders</p>
        <p className="text-[10px] text-muted-foreground/60">score {torrent.score.toFixed(1)}</p>
      </div>
    </button>
  )
}
