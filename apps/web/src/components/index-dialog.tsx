import { useState, useRef, useEffect } from "react"
import {
  Film,
  Tv,
  X,
  Database,
  Star,
  HardDrive,
  ArrowUpCircle,
  ArrowDownCircle,
  User,
  CloudDownload,
  RefreshCw,
  CheckCircle2,
  MoreVertical,
  Trash2,
  RotateCcw,
  Download,
  Loader2,
  Info,
} from "lucide-react"
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import type { IndexWithTorrents, Torrent } from "@findr/types"
import { fetchIMDbId, type TMDBMeta } from "@/hooks/use-tmdb-search"
import { TMDB_API_KEY, TMDB_BASE } from "@/hooks/use-tmdb-trending"

const TMDB_IMAGE = "https://image.tmdb.org/t/p/w500"

interface IndexDialogProps {
  indexes: IndexWithTorrents[]
  meta: TMDBMeta | null
  open: boolean
  onOpenChange: (open: boolean) => void
  onRedownloaded?: () => void
  onRemoved?: () => void
  onReindexed?: () => void
  onSeasonIndexed?: () => void
}

function formatSize(mb: number): string {
  if (mb >= 1024) return `${(mb / 1024).toFixed(1)} GB`
  return `${mb} MB`
}

function formatDate(date: string): { date: string; time: string } {
  const d = new Date(date)
  return {
    date: d.toLocaleDateString(undefined, {
      month: "short",
      day: "numeric",
      year: "numeric",
    }),
    time: d.toLocaleTimeString(undefined, {
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hour12: false,
      timeZoneName: "short",
    }),
  }
}

function ScoreBadge({ score }: { score: number }) {
  const isHigh = score >= 8
  const colorClass = isHigh
    ? "text-findr-success bg-findr-success/10"
    : "text-findr-amber bg-findr-amber/10"
  return (
    <span
      className={`inline-flex items-center gap-1 text-[11px] font-bold ${colorClass} px-2 py-0.5 rounded-full`}
    >
      <Star className="size-3" />
      {score.toFixed(1)}
    </span>
  )
}

function TorrentTag({
  label,
  variant = "default",
}: {
  label: string
  variant?: "default" | "hdr" | "release"
}) {
  const colorMap = {
    default:
      "bg-gray-100 border-gray-200 text-gray-700",
    hdr: "bg-purple-50 border-purple-200 text-purple-700",
    release: "bg-blue-50 border-blue-200 text-blue-700",
  }
  return (
    <span
      className={`px-2 py-0.5 rounded border text-[10px] font-bold ${colorMap[variant]}`}
    >
      {label}
    </span>
  )
}

function tagVariant(
  field: "resolution" | "videoCodec" | "audioCodec" | "hdrFormat" | "releaseType"
): "default" | "hdr" | "release" {
  if (field === "hdrFormat") return "hdr"
  if (field === "releaseType") return "release"
  return "default"
}

function TorrentRow({
  torrent,
  isSelected,
  isCurrent,
  onSelect,
  redownloadState,
}: {
  torrent: Torrent
  isSelected: boolean
  isCurrent: boolean
  onSelect: () => void
  redownloadState: "idle" | "loading" | "success"
}) {
  const tags: { label: string; variant: "default" | "hdr" | "release" }[] = []
  if (torrent.resolution)
    tags.push({ label: torrent.resolution, variant: tagVariant("resolution") })
  if (torrent.videoCodec)
    tags.push({ label: torrent.videoCodec, variant: tagVariant("videoCodec") })
  if (torrent.audioCodec)
    tags.push({ label: torrent.audioCodec, variant: tagVariant("audioCodec") })
  if (torrent.hdrFormat)
    tags.push({ label: torrent.hdrFormat, variant: tagVariant("hdrFormat") })
  if (torrent.releaseType)
    tags.push({
      label: torrent.releaseType,
      variant: tagVariant("releaseType"),
    })

  return (
    <label className="relative block bg-white border rounded-xl p-4 transition-all hover:shadow-md">
      <input
        type="radio"
        name="torrent_selection"
        checked={isSelected}
        onChange={onSelect}
        className="peer sr-only"
      />
      <div className="absolute inset-0 rounded-xl border-2 border-transparent peer-checked:border-findr-amber peer-checked:bg-[rgba(245,168,38,0.03)] pointer-events-none transition-all" />

      <div className="relative flex items-start gap-4 z-10">
        {/* Radio indicator */}
        <div
          className={`mt-1 w-5 h-5 rounded-full border-2 flex items-center justify-center shrink-0 bg-white transition-colors ${
            isSelected ? "border-findr-amber border-[5px]" : "border-findr-tertiary"
          }`}
        />

        <div className="flex-1 min-w-0">
          {/* Title & Score */}
          <div className="flex justify-between items-start gap-4 mb-1.5">
            <h4 className="font-mono text-[13px] font-semibold text-findr-text break-all leading-tight">
              {torrent.title}
            </h4>
            <div className="flex flex-col items-end shrink-0">
              <ScoreBadge score={torrent.score} />
              {isCurrent && isSelected && (
                <span className="mt-1 text-[9px] font-bold uppercase tracking-wider text-findr-amber">
                  Current File
                </span>
              )}
            </div>
          </div>

          {/* Tags */}
          {tags.length > 0 && (
            <div className="flex flex-wrap gap-1.5 mb-2.5">
              {tags.map((tag) => (
                <TorrentTag
                  key={tag.label}
                  label={tag.label}
                  variant={tag.variant}
                />
              ))}
            </div>
          )}

          {/* Stats footer */}
          <div className="flex flex-wrap items-center gap-x-5 gap-y-2 text-[11px] font-mono text-findr-secondary bg-gray-50/50 p-2 rounded-lg border border-gray-100">
            <span className="flex items-center gap-1.5 font-semibold text-findr-text">
              <HardDrive className="size-3.5 text-findr-tertiary" />
              {formatSize(torrent.sizeMB)}
            </span>
            <span className="flex items-center gap-1.5 text-findr-success font-medium">
              <ArrowUpCircle className="size-3.5" />
              {torrent.seeders.toLocaleString()} Seeders
            </span>
            <span className="flex items-center gap-1.5 text-findr-error font-medium">
              <ArrowDownCircle className="size-3.5" />
              {torrent.leechers.toLocaleString()} Leechers
            </span>
            {torrent.uploaderName && (
              <span className="flex items-center gap-1.5 text-findr-tertiary ml-auto">
                <User className="size-3.5" />
                {torrent.uploaderName}
              </span>
            )}
          </div>

          {/* Redownload feedback */}
          {redownloadState === "loading" && (
            <div className="mt-3 p-2 bg-findr-amber/10 border border-findr-amber/30 rounded-lg flex items-center justify-center gap-2 text-findr-amber text-xs font-bold animate-fade-in">
              <RefreshCw className="size-3.5 animate-spin" />
              Triggering Redownload...
            </div>
          )}
          {redownloadState === "success" && (
            <div className="mt-3 p-2 bg-findr-success/10 border border-findr-success/30 rounded-lg flex items-center justify-center gap-2 text-findr-success text-xs font-bold animate-fade-in">
              <CheckCircle2 className="size-3.5" />
              Job queued successfully.
            </div>
          )}
        </div>
      </div>
    </label>
  )
}

export function IndexDialog({
  indexes,
  meta,
  open,
  onOpenChange,
  onRedownloaded,
  onRemoved,
  onReindexed,
  onSeasonIndexed,
}: IndexDialogProps) {
  const [selectedSeasonIdx, setSelectedSeasonIdx] = useState(0)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [redownloadingId, setRedownloadingId] = useState<string | null>(null)
  const [successId, setSuccessId] = useState<string | null>(null)
  const [menuOpen, setMenuOpen] = useState(false)
  const menuRef = useRef<HTMLDivElement>(null)

  // Missing seasons state
  const [totalSeasons, setTotalSeasons] = useState<number | null>(null)
  const [missingSeasonPick, setMissingSeasonPick] = useState<number | null>(null)
  const [indexingSeason, setIndexingSeason] = useState(false)
  const [indexSeasonResult, setIndexSeasonResult] = useState<"success" | "error" | null>(null)

  const index = indexes[selectedSeasonIdx] ?? null
  const currentSourceId = index?.sourceId ?? null
  const activeId = selectedId ?? currentSourceId
  const torrents = index?.torrents ?? []
  const isMovie = meta?.mediaType !== "tv"
  const isSeries = !isMovie
  const TypeIcon = isMovie ? Film : Tv

  const indexedSeasons = new Set(indexes.map((idx) => idx.season).filter((s): s is number => s != null))
  const missingSeasons = totalSeasons != null
    ? Array.from({ length: totalSeasons }, (_, i) => i + 1).filter((s) => !indexedSeasons.has(s))
    : []

  useEffect(() => {
    if (!menuOpen) return
    function handleClick(e: MouseEvent) {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setMenuOpen(false)
      }
    }
    document.addEventListener("mousedown", handleClick)
    return () => document.removeEventListener("mousedown", handleClick)
  }, [menuOpen])

  // Fetch total season count for series
  useEffect(() => {
    if (!isSeries || !meta?.tmdbId || !open) {
      setTotalSeasons(null)
      return
    }
    let cancelled = false
    fetch(`${TMDB_BASE}/tv/${meta.tmdbId}?api_key=${TMDB_API_KEY}`)
      .then((res) => res.json())
      .then((data) => {
        if (!cancelled) setTotalSeasons(data.number_of_seasons ?? null)
      })
      .catch(() => {
        if (!cancelled) setTotalSeasons(null)
      })
    return () => { cancelled = true }
  }, [isSeries, meta?.tmdbId, open])

  function handleOpenChange(v: boolean) {
    onOpenChange(v)
    if (!v) {
      setSelectedSeasonIdx(0)
      setSelectedId(null)
      setRedownloadingId(null)
      setSuccessId(null)
      setMenuOpen(false)
      setTotalSeasons(null)
      setMissingSeasonPick(null)
      setIndexingSeason(false)
      setIndexSeasonResult(null)
    }
  }

  function handleSeasonChange(idx: number) {
    setSelectedSeasonIdx(idx)
    setSelectedId(null)
    setRedownloadingId(null)
    setSuccessId(null)
  }

  async function handleRemove() {
    if (!index) return
    setMenuOpen(false)
    try {
      const res = await fetch(`/api/indexes/${index.id}/delete`, {
        method: "DELETE",
        credentials: "include",
      })
      if (!res.ok) return
      handleOpenChange(false)
      onRemoved?.()
    } catch {
      // silently fail
    }
  }

  async function handleReindex() {
    if (!index) return
    setMenuOpen(false)
    try {
      const res = await fetch(`/api/indexes/${index.id}/reindex`, {
        method: "POST",
        credentials: "include",
      })
      if (!res.ok) return
      handleOpenChange(false)
      onReindexed?.()
    } catch {
      // silently fail
    }
  }

  async function handleIndexMissingSeason() {
    if (!index || missingSeasonPick == null || indexingSeason) return
    setIndexingSeason(true)
    setIndexSeasonResult(null)
    try {
      const imdbId = index.imdbId.startsWith("tt")
        ? index.imdbId
        : await fetchIMDbId(meta!.tmdbId, "tv")
      if (!imdbId) throw new Error("No IMDb ID")

      const res = await fetch("/api/jobs/create", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ imdbId, season: missingSeasonPick }),
      })
      if (!res.ok) throw new Error("Request failed")
      setIndexSeasonResult("success")
      onSeasonIndexed?.()
    } catch {
      setIndexSeasonResult("error")
    } finally {
      setIndexingSeason(false)
    }
  }

  async function triggerRedownload(torrentId: string) {
    if (!index || redownloadingId) return
    setRedownloadingId(torrentId)
    setSuccessId(null)

    try {
      const res = await fetch(`/api/indexes/${index.id}/redownload`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ torrentId }),
      })

      if (!res.ok) {
        const data = await res.json().catch(() => null)
        throw new Error(data?.error ?? `Request failed (${res.status})`)
      }

      setRedownloadingId(null)
      setSuccessId(torrentId)
      onRedownloaded?.()

      setTimeout(() => setSuccessId(null), 2500)
    } catch {
      setRedownloadingId(null)
    }
  }

  function handleTorrentSelect(torrentId: string) {
    if (torrentId === activeId) {
      triggerRedownload(torrentId)
    } else {
      setSelectedId(torrentId)
      triggerRedownload(torrentId)
    }
  }

  const created = index ? formatDate(index.createdAt) : null

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent
        showCloseButton={false}
        className="max-w-6xl max-h-[90vh] p-0 overflow-hidden flex flex-col rounded-2xl gap-0"
      >
        {/* Title Bar */}
        <div className="flex items-center justify-end gap-1 px-5 pt-3 pb-2 bg-white z-10 shrink-0">
          <DialogHeader>
            <DialogTitle className="sr-only">
              {meta?.title ?? index?.imdbId}
            </DialogTitle>
          </DialogHeader>

          {/* 3-dot menu */}
          <div className="relative" ref={menuRef}>
            <button
              onClick={() => setMenuOpen((v) => !v)}
              className="w-10 h-10 flex items-center justify-center rounded-full hover:bg-findr-hover text-findr-secondary hover:text-findr-text transition-colors bg-white border border-transparent hover:border-findr-border shrink-0"
            >
              <MoreVertical className="size-5" />
            </button>
            {menuOpen && (
              <div className="absolute right-0 top-full mt-1 w-48 bg-white border border-findr-border rounded-xl shadow-lg py-1 z-50">
                <button
                  onClick={handleReindex}
                  className="w-full flex items-center gap-2.5 px-4 py-2.5 text-sm font-medium text-findr-text hover:bg-findr-hover transition-colors"
                >
                  <RotateCcw className="size-4 text-findr-secondary" />
                  Re-index {isSeries && index?.season != null ? `Season ${index.season}` : ""}
                </button>
                <button
                  onClick={handleRemove}
                  className="w-full flex items-center gap-2.5 px-4 py-2.5 text-sm font-medium text-findr-error hover:bg-red-50 transition-colors"
                >
                  <Trash2 className="size-4" />
                  Remove {isSeries && index?.season != null ? `Season ${index.season}` : "Index"}
                </button>
              </div>
            )}
          </div>

          <button
            onClick={() => handleOpenChange(false)}
            className="w-10 h-10 flex items-center justify-center rounded-full hover:bg-findr-hover text-findr-secondary hover:text-findr-text transition-colors bg-white border border-transparent hover:border-findr-border shrink-0"
          >
            <X className="size-5" />
          </button>
        </div>

        {/* Scrollable content */}
        <div className="flex flex-col flex-1 overflow-y-auto bg-findr-bg">
          {/* Top: Poster & Metadata */}
          <div className="w-full p-4 sm:p-6 border-b border-findr-border bg-white flex flex-col md:flex-row gap-6 shrink-0">
            {/* Poster */}
            <div className="w-[60%] sm:w-1/2 md:w-[260px] lg:w-[300px] mx-auto md:mx-0 aspect-[2/3] rounded-xl overflow-hidden shadow-md border border-findr-border shrink-0">
              {meta?.posterPath ? (
                <img
                  src={`${TMDB_IMAGE}${meta.posterPath}`}
                  alt={meta.title}
                  className="w-full h-full object-cover"
                />
              ) : (
                <div className="w-full h-full flex items-center justify-center bg-findr-hover">
                  <TypeIcon className="size-12 text-findr-tertiary" />
                </div>
              )}
            </div>

            {/* Text & Metadata */}
            <div className="flex-1 flex flex-col gap-6">
              <div>
                <div className="flex items-center gap-3 mb-2">
                  <div
                    className={`${
                      isMovie
                        ? "bg-[rgba(34,197,94,0.15)] text-findr-success border-[rgba(34,197,94,0.2)]"
                        : "bg-[rgba(245,168,38,0.15)] text-findr-amber border-[rgba(245,168,38,0.2)]"
                    } px-3 py-1 rounded-full flex items-center gap-1.5 border`}
                  >
                    <TypeIcon className="size-3.5" />
                    <span className="text-xs font-bold uppercase tracking-widest">
                      {isMovie ? "Movie" : "Series"}
                    </span>
                  </div>
                  {isSeries && indexes.length > 1 && (
                    <select
                      value={selectedSeasonIdx}
                      onChange={(e) => handleSeasonChange(Number(e.target.value))}
                      className="h-8 px-3 bg-white border border-findr-border rounded-full text-xs font-bold text-findr-text focus:outline-none focus:border-findr-amber cursor-pointer hover:border-findr-tertiary transition-all appearance-none pr-7 bg-no-repeat"
                      style={{
                        backgroundImage: `url('data:image/svg+xml;utf8,<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="%23666666" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m6 9 6 6 6-6"/></svg>')`,
                        backgroundPosition: "right 8px center",
                        backgroundSize: "14px",
                      }}
                    >
                      {indexes.map((idx, i) => (
                        <option key={idx.id} value={i}>
                          Season {idx.season}
                        </option>
                      ))}
                    </select>
                  )}
                  {isSeries && indexes.length === 1 && index?.season != null && (
                    <span className="text-sm font-bold text-findr-secondary">
                      Season {index.season}
                    </span>
                  )}
                </div>
                <h2 className="text-2xl md:text-3xl font-extrabold text-findr-text mb-3">
                  {meta?.title ?? index?.imdbId}{" "}
                  {meta?.year && (
                    <span className="text-findr-tertiary font-medium">
                      ({meta.year})
                    </span>
                  )}
                </h2>
                {meta?.overview && (
                  <p className="text-sm text-findr-secondary leading-relaxed line-clamp-4">
                    {meta.overview}
                  </p>
                )}
              </div>

              {/* Index Metadata Card */}
              <div className="bg-findr-hover rounded-xl p-4 border border-findr-border space-y-3">
                <div className="flex items-center gap-2 pb-2 border-b border-findr-border/50">
                  <Database className="size-4 text-findr-secondary" />
                  <h3 className="text-sm font-bold text-findr-text">
                    Index Details
                  </h3>
                </div>

                <div className="space-y-2">
                  {created && (
                    <div className="flex justify-between items-start">
                      <span className="text-xs text-findr-secondary font-medium">
                        Indexed Date
                      </span>
                      <span className="text-xs font-mono font-medium text-findr-text text-right">
                        {created.date}
                        <br />
                        <span className="text-[10px] text-findr-tertiary">
                          {created.time}
                        </span>
                      </span>
                    </div>
                  )}
                  <div className="flex justify-between items-center">
                    <span className="text-xs text-findr-secondary font-medium">
                      IMDb ID
                    </span>
                    <a
                      href={`https://www.imdb.com/title/${index?.imdbId}`}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-xs font-mono font-medium text-findr-amber hover:underline"
                    >
                      {index?.imdbId}
                    </a>
                  </div>
                  <div className="flex justify-between items-center pt-2 mt-2 border-t border-findr-border/50">
                    <span className="text-xs text-findr-secondary font-medium">
                      Status
                    </span>
                    <span className="text-xs font-bold uppercase tracking-wider text-findr-success bg-findr-success/10 px-2 py-0.5 rounded">
                      Available
                    </span>
                  </div>
                </div>
              </div>
            </div>
          </div>

          {/* Missing Seasons Alert */}
          {isSeries && missingSeasons.length > 0 && (
            <div className="w-full px-4 sm:px-6 pt-4 sm:pt-6 bg-[#F8F9FA]">
              <div className="flex items-start gap-3 p-4 rounded-xl bg-blue-50 border border-blue-200">
                <Info className="size-5 text-blue-500 shrink-0 mt-0.5" />
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-bold text-blue-900 mb-1">
                    {missingSeasons.length} season{missingSeasons.length > 1 ? "s" : ""} not yet indexed
                  </p>
                  <p className="text-xs text-blue-700 mb-3">
                    This series has {totalSeasons} season{totalSeasons! > 1 ? "s" : ""} total.
                    You can index additional seasons below.
                  </p>
                  <div className="flex items-center gap-2">
                    <select
                      value={missingSeasonPick ?? ""}
                      onChange={(e) => setMissingSeasonPick(e.target.value ? Number(e.target.value) : null)}
                      className="h-9 px-3 bg-white border border-blue-200 rounded-lg text-xs font-bold text-findr-text focus:outline-none focus:border-blue-400 cursor-pointer hover:border-blue-300 transition-all appearance-none pr-7 bg-no-repeat"
                      style={{
                        backgroundImage: `url('data:image/svg+xml;utf8,<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="%234B7BEC" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m6 9 6 6 6-6"/></svg>')`,
                        backgroundPosition: "right 8px center",
                        backgroundSize: "14px",
                      }}
                    >
                      <option value="">Select season</option>
                      {missingSeasons.map((s) => (
                        <option key={s} value={s}>Season {s}</option>
                      ))}
                    </select>
                    <button
                      onClick={handleIndexMissingSeason}
                      disabled={missingSeasonPick == null || indexingSeason || indexSeasonResult === "success"}
                      className="h-9 px-4 bg-blue-600 hover:bg-blue-700 disabled:opacity-50 text-white font-bold text-xs rounded-lg flex items-center gap-1.5 transition-colors"
                    >
                      {indexingSeason ? (
                        <Loader2 className="size-3.5 animate-spin" />
                      ) : indexSeasonResult === "success" ? (
                        <CheckCircle2 className="size-3.5" />
                      ) : (
                        <Download className="size-3.5" />
                      )}
                      {indexSeasonResult === "success" ? "Queued" : "Index Season"}
                    </button>
                  </div>
                  {indexSeasonResult === "error" && (
                    <p className="text-xs text-red-600 mt-2 font-medium">Failed to create job. Try again.</p>
                  )}
                </div>
              </div>
            </div>
          )}

          {/* Torrents Section */}
          <div className="w-full p-4 sm:p-6 flex flex-col bg-[#F8F9FA]">
            <div className="flex items-center justify-between mb-4 shrink-0">
              <div>
                <h3 className="text-lg font-extrabold text-findr-text flex items-center gap-2">
                  <CloudDownload className="size-5 text-findr-amber" />
                  Associated Torrents
                </h3>
                <p className="text-xs text-findr-secondary">
                  Select a release to make it the active download for this item.
                </p>
              </div>
              <div className="text-sm font-mono text-findr-tertiary bg-white border border-findr-border px-3 py-1 rounded-full">
                {torrents.length} Found
              </div>
            </div>

            <div className="space-y-3 pb-6">
              {torrents.map((torrent) => {
                const isSelected = torrent.id === activeId
                const isCurrent = torrent.id === currentSourceId
                const redownloadState =
                  redownloadingId === torrent.id
                    ? "loading"
                    : successId === torrent.id
                      ? "success"
                      : "idle"

                return (
                  <TorrentRow
                    key={torrent.id}
                    torrent={torrent}
                    isSelected={isSelected}
                    isCurrent={isCurrent}
                    onSelect={() => handleTorrentSelect(torrent.id)}
                    redownloadState={
                      redownloadState as "idle" | "loading" | "success"
                    }
                  />
                )
              })}

              {torrents.length === 0 && (
                <div className="flex flex-col items-center justify-center py-12 text-center">
                  <CloudDownload className="size-10 text-findr-tertiary/40 mb-3" />
                  <p className="text-sm font-medium text-findr-secondary">
                    No torrents found
                  </p>
                </div>
              )}
            </div>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  )
}
