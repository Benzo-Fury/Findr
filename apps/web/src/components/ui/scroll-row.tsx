import * as React from "react"
import { CaretLeftIcon, CaretRightIcon } from "@phosphor-icons/react"
import { cn } from "@/lib/utils"

interface ScrollRowProps {
  /** Accessible name for the row. */
  label: string
  children: React.ReactNode
  /** Classes for the scrolling track, such as its gap and item padding. */
  trackClassName?: string
  className?: string
}

/**
 * A horizontal shelf that snaps to its items. Touch and trackpads scroll it
 * natively; on desktop, arrow buttons appear at whichever end has more.
 * The ends are watched with an IntersectionObserver, not scroll events.
 */
export function ScrollRow({ label, children, trackClassName, className }: ScrollRowProps) {
  const trackRef = React.useRef<HTMLDivElement>(null)
  const startRef = React.useRef<HTMLSpanElement>(null)
  const endRef = React.useRef<HTMLSpanElement>(null)
  const [atStart, setAtStart] = React.useState(true)
  const [atEnd, setAtEnd] = React.useState(false)

  // Sentinels at either end report when the row reaches them
  React.useEffect(() => {
    const track = trackRef.current
    if (!track || !startRef.current || !endRef.current) return
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.target === startRef.current) setAtStart(entry.isIntersecting)
          if (entry.target === endRef.current) setAtEnd(entry.isIntersecting)
        }
      },
      { root: track, threshold: 0.99 },
    )
    observer.observe(startRef.current)
    observer.observe(endRef.current)
    return () => observer.disconnect()
  }, [])

  function page(direction: 1 | -1) {
    const track = trackRef.current
    if (!track) return
    const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches
    track.scrollBy({ left: direction * track.clientWidth * 0.85, behavior: reduce ? "auto" : "smooth" })
  }

  return (
    <div role="region" aria-label={label} className={cn("group/row relative", className)}>
      <div ref={trackRef} className={cn("scroll-x -my-3 flex snap-x py-3 snap-mandatory scroll-px-4 md:scroll-px-8", trackClassName)}>
        <span ref={startRef} aria-hidden className="w-px shrink-0" />
        {children}
        <span ref={endRef} aria-hidden className="w-px shrink-0" />
      </div>
      <EdgeButton side="left" hidden={atStart} onClick={() => page(-1)} />
      <EdgeButton side="right" hidden={atEnd} onClick={() => page(1)} />
    </div>
  )
}

interface EdgeButtonProps {
  side: "left" | "right"
  hidden: boolean
  onClick: () => void
}

function EdgeButton({ side, hidden, onClick }: EdgeButtonProps) {
  const EdgeIcon = side === "left" ? CaretLeftIcon : CaretRightIcon
  return (
    <button
      type="button"
      tabIndex={-1}
      aria-hidden
      onClick={onClick}
      className={cn(
        "absolute top-[38%] z-[1] hidden size-11 -translate-y-1/2 items-center justify-center rounded-full bg-surface text-ink shadow-lift",
        "transition-[opacity,transform] duration-300 ease-out-expo hover:scale-105 active:scale-95 [@media(hover:hover)]:flex",
        side === "left" ? "left-2 md:left-4" : "right-2 md:right-4",
        hidden ? "pointer-events-none opacity-0" : "opacity-0 group-hover/row:opacity-100",
      )}
    >
      <EdgeIcon weight="bold" className="size-5" />
    </button>
  )
}
