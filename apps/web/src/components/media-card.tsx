import { Film, Tv, Plus } from "lucide-react"
import { Badge } from "@/components/ui/badge"
import { cn } from "@/lib/utils"

const POSTER_BASE = "https://image.tmdb.org/t/p/w342"

interface MediaCardProps {
  title: string
  year?: string
  posterPath: string | null
  mediaType: "movie" | "tv"
  rating?: number
  onClick?: () => void
  actionLabel?: string
  onAction?: () => void
  compact?: boolean
}

export function MediaCard({
  title,
  year,
  posterPath,
  mediaType,
  rating,
  onClick,
  actionLabel,
  onAction,
  compact,
}: MediaCardProps) {
  return (
    <div
      className={cn(
        "group relative cursor-pointer overflow-hidden border bg-card transition-all hover:border-ring/50 hover:shadow-lg hover:shadow-ring/5",
        compact ? "rounded-lg" : "rounded-xl",
      )}
      onClick={onClick}
    >
      <div className="relative aspect-[2/3] overflow-hidden">
        {posterPath ? (
          <img
            src={`${POSTER_BASE}${posterPath}`}
            alt={title}
            className="size-full object-cover transition-transform duration-300 group-hover:scale-105"
            loading="lazy"
          />
        ) : (
          <div className="flex size-full items-center justify-center bg-muted">
            {mediaType === "movie" ? (
              <Film className={cn(compact ? "size-5" : "size-8", "text-muted-foreground")} />
            ) : (
              <Tv className={cn(compact ? "size-5" : "size-8", "text-muted-foreground")} />
            )}
          </div>
        )}

        <div className="absolute inset-0 bg-gradient-to-t from-black/80 via-black/20 to-transparent opacity-60 transition-opacity group-hover:opacity-80" />

        {!compact && (
          <Badge
            variant={mediaType === "movie" ? "success" : "warning"}
            className="absolute top-2 right-2 text-[10px]"
          >
            {mediaType === "movie" ? "Movie" : "Series"}
          </Badge>
        )}

        <div className={cn(
          "absolute inset-x-0 bottom-0 transition-transform duration-300 group-hover:translate-y-[-4px]",
          compact ? "p-2" : "p-3",
        )}>
          <p className={cn(
            "truncate font-semibold text-white drop-shadow",
            compact ? "text-xs" : "text-sm",
          )}>{title}</p>
          <div className={cn(
            "mt-0.5 flex items-center gap-1.5 text-white/70",
            compact ? "text-[10px]" : "text-xs",
          )}>
            {year && <span>{year}</span>}
            {year && rating !== undefined && rating > 0 && (
              <span className="text-white/40">&#8226;</span>
            )}
            {rating !== undefined && rating > 0 && (
              <span className="flex items-center gap-0.5">
                <span className="text-amber-400">&#9733;</span>
                {rating.toFixed(1)}
              </span>
            )}
          </div>
        </div>

        {actionLabel && onAction && (
          <button
            onClick={(e) => {
              e.stopPropagation()
              onAction()
            }}
            className="absolute inset-x-3 bottom-3 flex translate-y-full items-center justify-center gap-1.5 rounded-lg bg-ring py-2 text-xs font-medium text-white opacity-0 transition-all group-hover:translate-y-0 group-hover:opacity-100"
          >
            <Plus className="size-3.5" />
            {actionLabel}
          </button>
        )}
      </div>
    </div>
  )
}
