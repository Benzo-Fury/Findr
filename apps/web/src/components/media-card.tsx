import { Film, Tv, Star, Download } from "lucide-react"

interface MediaCardProps {
  title: string
  year: string
  rating: number
  posterUrl: string | null
  mediaType: "movie" | "tv"
  onClick?: () => void
  onAction?: () => void
}

export function MediaCard({
  title,
  year,
  rating,
  posterUrl,
  mediaType,
  onClick,
  onAction,
}: MediaCardProps) {
  const isMovie = mediaType === "movie"
  const badgeBg = isMovie
    ? "bg-[rgba(34,197,94,0.35)]"
    : "bg-[rgba(245,168,38,0.35)]"
  const TypeIcon = isMovie ? Film : Tv
  const typeLabel = isMovie ? "Movie" : "Series"

  return (
    <div
      onClick={onClick}
      className={`group relative aspect-[2/3] rounded-xl overflow-hidden bg-white border border-findr-border shadow-sm hover:shadow-xl transition-all duration-300${onClick ? " cursor-pointer" : ""}`}
    >
      {posterUrl ? (
        <img
          src={posterUrl}
          alt={title}
          className="w-full h-full object-cover transition-transform duration-700 group-hover:scale-105"
        />
      ) : (
        <div className="w-full h-full flex items-center justify-center bg-findr-hover">
          <TypeIcon className="size-12 text-findr-tertiary" />
        </div>
      )}

      {/* Gradient Overlay */}
      <div className="absolute inset-0 pointer-events-none poster-gradient transition-all duration-300" />

      {/* Type Badge */}
      <div
        className={`absolute top-3 right-3 flex items-center gap-1.5 ${badgeBg} px-3 py-1.5 z-10 rounded-full backdrop-blur-md border border-white/20`}
      >
        <TypeIcon className="size-3.5 text-white" />
        <span className="text-[10px] font-bold uppercase text-white tracking-widest">
          {typeLabel}
        </span>
      </div>

      {/* Content Container (Moves up on hover) */}
      <div className="absolute inset-0 z-10 flex flex-col justify-end p-4 transition-transform duration-300 group-hover:-translate-y-[52px]">
        <h3 className="font-extrabold text-[17px] text-white leading-tight line-clamp-2 mb-2 drop-shadow-md">
          {title}
        </h3>
        <div className="flex items-center gap-3 text-[13px] font-medium text-white/90">
          <span>{year}</span>
          <span className="w-1 h-1 rounded-full bg-white/50" />
          <div className="flex items-center gap-1 text-findr-amber">
            <Star className="size-3.5 fill-current" />
            <span className="text-white font-bold">{rating.toFixed(1)}</span>
          </div>
        </div>
      </div>

      {/* Action Button (Slides up on hover) */}
      <div className="absolute bottom-0 left-0 right-0 p-4 z-20 translate-y-full opacity-0 group-hover:translate-y-0 group-hover:opacity-100 transition-all duration-300">
        <button
          onClick={onAction}
          className="w-full h-11 bg-findr-amber hover:bg-findr-amber-hover text-findr-text font-bold text-sm rounded-lg flex items-center justify-center gap-2 transition-colors shadow-lg shadow-amber-500/20"
        >
          <Download className="size-[18px]" />
          Index Item
        </button>
      </div>

      {/* Hover Border Glow */}
      <div className="absolute inset-0 opacity-0 group-hover:opacity-100 transition-opacity duration-300 shadow-[inset_0_0_0_2px_rgba(245,168,38,0.6)] rounded-xl pointer-events-none z-30" />
    </div>
  )
}
