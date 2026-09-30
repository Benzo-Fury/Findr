import * as React from "react"
import { ChevronLeft, ChevronRight } from "lucide-react"
import { MediaCard } from "@/components/media-card"
import { cn } from "@/lib/utils"
import type { PosterItem } from "@/lib/types"

const POSTER_BASE = "https://image.tmdb.org/t/p/w342"

interface MediaRowProps {
  title: string
  items: PosterItem[]
  ranked?: boolean
  onItemClick: (item: PosterItem) => void
}

export function MediaRow({ title, items, ranked, onItemClick }: MediaRowProps) {
  const scrollRef = React.useRef<HTMLDivElement>(null)
  const [canScrollLeft, setCanScrollLeft] = React.useState(false)
  const [canScrollRight, setCanScrollRight] = React.useState(false)

  const checkScroll = React.useCallback(() => {
    const el = scrollRef.current
    if (!el) return
    setCanScrollLeft(el.scrollLeft > 0)
    setCanScrollRight(el.scrollLeft + el.clientWidth < el.scrollWidth - 1)
  }, [])

  React.useEffect(() => {
    checkScroll()
    const el = scrollRef.current
    if (!el) return
    el.addEventListener("scroll", checkScroll, { passive: true })
    const observer = new ResizeObserver(checkScroll)
    observer.observe(el)
    return () => {
      el.removeEventListener("scroll", checkScroll)
      observer.disconnect()
    }
  }, [checkScroll, items])

  function scroll(direction: "left" | "right") {
    const el = scrollRef.current
    if (!el) return
    const amount = el.clientWidth * 0.8
    el.scrollBy({ left: direction === "left" ? -amount : amount, behavior: "smooth" })
  }

  return (
    <div className="group/row relative">
      <h2 className="mb-3 px-4 text-lg font-semibold lg:px-6">{title}</h2>

      <div className="relative">
        {canScrollLeft && (
          <button
            onClick={() => scroll("left")}
            className="absolute left-0 top-0 bottom-0 z-10 flex w-10 items-center justify-center bg-gradient-to-r from-background to-transparent opacity-0 transition-opacity group-hover/row:opacity-100"
          >
            <ChevronLeft className="size-6 text-foreground" />
          </button>
        )}

        <div
          ref={scrollRef}
          className="flex gap-3 overflow-x-auto overflow-y-hidden px-4 pb-2 scrollbar-hide lg:px-6"
        >
          {items.map((item, i) => (
            <div
              key={`${item.mediaType}-${item.id}`}
              className={cn(
                "flex-shrink-0",
                ranked
                  ? "w-52 sm:w-56 md:w-64 lg:w-72"
                  : "w-36 sm:w-40 md:w-44 lg:w-48",
              )}
            >
              {ranked ? (
                <RankedCard
                  item={item}
                  rank={i + 1}
                  onClick={() => onItemClick(item)}
                />
              ) : (
                <MediaCard
                  title={item.title}
                  year={item.year}
                  posterPath={item.posterPath}
                  mediaType={item.mediaType}
                  rating={item.voteAverage}
                  onClick={() => onItemClick(item)}
                />
              )}
            </div>
          ))}
        </div>

        {canScrollRight && (
          <button
            onClick={() => scroll("right")}
            className="absolute right-0 top-0 bottom-0 z-10 flex w-10 items-center justify-center bg-gradient-to-l from-background to-transparent opacity-0 transition-opacity group-hover/row:opacity-100"
          >
            <ChevronRight className="size-6 text-foreground" />
          </button>
        )}
      </div>
    </div>
  )
}

// ---- Ranked card for Top 10 style ----

interface RankedCardProps {
  item: PosterItem
  rank: number
  onClick: () => void
}

function RankedCard({ item, rank, onClick }: RankedCardProps) {
  return (
    <div
      className="group relative flex cursor-pointer items-end"
      onClick={onClick}
    >
      <span
        className="ranked-number relative z-0 flex-shrink-0 select-none font-black leading-[0.75] tracking-tighter"
        style={{ fontSize: rank >= 10 ? "8rem" : "10rem" }}
      >
        {rank}
      </span>

      <div className="relative z-10 -ml-5 aspect-[2/3] w-[60%] flex-shrink-0 overflow-hidden rounded-lg border bg-card transition-all group-hover:border-ring/50 group-hover:shadow-lg group-hover:shadow-ring/5">
        {item.posterPath ? (
          <img
            src={`${POSTER_BASE}${item.posterPath}`}
            alt={item.title}
            className="size-full object-cover transition-transform duration-300 group-hover:scale-105"
            loading="lazy"
          />
        ) : (
          <div className="flex size-full items-center justify-center bg-muted" />
        )}
      </div>
    </div>
  )
}
