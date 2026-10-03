import * as React from "react"
import { AnimatePresence, motion, useReducedMotion } from "motion/react"
import { ArrowRightIcon, StarIcon } from "@phosphor-icons/react"
import { EASE_OUT, SPRING_SNAP } from "@/lib/motion"
import { useTitleRoute } from "@/lib/title-route"
import { tmdbImage } from "@/lib/tmdb-image"
import type { PosterItem } from "@/lib/types"
import { cn } from "@/lib/utils"
import { Button } from "@/components/ui/button"
import { Poster } from "@/components/ui/poster"
import { StatusLabel } from "@/components/ui/status-label"
import { usePosterActions } from "@/components/media/use-poster-actions"

interface SpotlightProps {
  items: PosterItem[]
  scope: string
}

/** How many titles share the stage. */
const STAGE_COUNT = 6

/** How long each title holds the stage before the next comes on, in milliseconds. */
const ADVANCE_MS = 5500

/** How long the stage stays put after a touch or a scroll of the queue, in milliseconds. */
const RESUME_AFTER_MS = 6000

/**
 * The opening stage of Discover. One title fills a wide still; the others
 * wait in a list beside it, and pointing at one (or focusing it) brings it
 * on stage. Left alone, the stage moves on to the next title every few
 * seconds, with a hairline under the current one counting down. It holds
 * still while the reader points at it, tabs into it, touches or scrolls
 * the queue, has a title open, or has scrolled it out of view, and never
 * advances under reduced motion.
 */
export function Spotlight({ items, scope }: SpotlightProps) {
  const staged = React.useMemo(() => items.filter((item) => item.backdropPath).slice(0, STAGE_COUNT), [items])
  const [index, setIndex] = React.useState(0)
  const { open, known } = usePosterActions(scope)
  const { open: titleOpen } = useTitleRoute()
  const reducedMotion = useReducedMotion()
  const sectionRef = React.useRef<HTMLElement>(null)
  const railRef = React.useRef<HTMLOListElement>(null)
  const advanced = React.useRef(false)
  const [hovered, setHovered] = React.useState(false)
  const [focused, setFocused] = React.useState(false)
  const [held, hold] = useHold(RESUME_AFTER_MS)
  const onScreen = useOnScreen(sectionRef)
  const pageVisible = usePageVisible()

  const autoplay = !reducedMotion && staged.length > 1
  const paused = hovered || focused || held || !onScreen || !pageVisible || titleOpen !== null

  // When the stage moves on by itself, bring the new title into view in the
  // queue where it scrolls sideways (phones and tablets), without touching
  // the page's own scroll
  React.useEffect(() => {
    if (!advanced.current) return
    advanced.current = false
    const rail = railRef.current
    const item = rail?.children[index] as HTMLElement | undefined
    if (!rail || !item || rail.scrollWidth <= rail.clientWidth) return
    const railBox = rail.getBoundingClientRect()
    const itemBox = item.getBoundingClientRect()
    rail.scrollTo({ left: rail.scrollLeft + itemBox.left - railBox.left - (railBox.width - itemBox.width) / 2, behavior: "smooth" })
  }, [index])

  const current = staged[Math.min(index, staged.length - 1)]
  if (!current) return null
  const state = known(current)

  function advance() {
    advanced.current = true
    setIndex((position) => (position + 1) % staged.length)
  }

  return (
    <section
      ref={sectionRef}
      aria-label="Spotlight"
      onPointerEnter={(event) => event.pointerType === "mouse" && setHovered(true)}
      onPointerLeave={(event) => event.pointerType === "mouse" && setHovered(false)}
      onPointerDown={(event) => event.pointerType !== "mouse" && hold()}
      onFocus={(event) => event.target.matches(":focus-visible") && setFocused(true)}
      onBlur={(event) => !event.currentTarget.contains(event.relatedTarget) && setFocused(false)}
      className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_19rem] lg:gap-6"
    >
      {/* Stage; a click anywhere on it opens the title, and the button's own
          click reaches it the same way so keyboard use still works */}
      <div
        onClick={() => open(current)}
        className="group/stage relative aspect-[4/5] cursor-pointer overflow-hidden rounded-panel bg-ink shadow-ring transition-shadow duration-300 hover:shadow-lift sm:aspect-[16/10] lg:aspect-auto lg:min-h-[30rem]"
      >
        <div className="absolute inset-0 transition-transform duration-700 ease-out-expo group-hover/stage:scale-[1.04]">
          <AnimatePresence initial={false} mode="popLayout">
            <motion.img
              key={current.id}
              src={tmdbImage(current.backdropPath, "backdropLarge") ?? undefined}
              alt=""
              initial={{ opacity: 0, scale: 1.08 }}
              animate={{ opacity: 1, scale: 1 }}
              exit={{ opacity: 0 }}
              transition={{ duration: 0.9, ease: EASE_OUT }}
              className="absolute inset-0 size-full object-cover"
            />
          </AnimatePresence>
        </div>
        <div className="absolute inset-0 bg-[linear-gradient(to_top,oklch(0.16_0.02_265/0.92),oklch(0.16_0.02_265/0.35)_45%,transparent_70%)]" />
        <div className="absolute inset-x-0 bottom-0 p-5 md:p-8">
          <AnimatePresence mode="wait" initial={false}>
            <motion.div
              key={current.id}
              initial={{ opacity: 0, y: 16 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -8 }}
              transition={{ duration: 0.35, ease: EASE_OUT }}
              className="max-w-2xl"
            >
              <div className="mb-3 flex items-center gap-3 text-[0.8125rem] text-surface/80">
                <span className="font-mono tabular">{current.year}</span>
                <span>{current.mediaType === "tv" ? "Series" : "Film"}</span>
                {current.voteAverage > 0 && (
                  <span className="inline-flex items-center gap-1 font-mono tabular">
                    <StarIcon aria-hidden weight="fill" className="size-3.5 text-signal" />
                    {current.voteAverage.toFixed(1)}
                  </span>
                )}
              </div>
              <h2 className="display text-[2.75rem] text-surface [text-wrap:balance] md:text-7xl lg:text-8xl">{current.title}</h2>
              {current.overview && <p className="mt-3 line-clamp-2 max-w-[60ch] text-[0.9375rem] leading-relaxed text-surface/80 max-sm:hidden">{current.overview}</p>}
              <div className="mt-5 flex flex-wrap items-center gap-3">
                <Button variant="signal" size="lg" iconEnd={ArrowRightIcon}>
                  View title
                </Button>
                {state && <StatusLabel status={state.status} variant="filled" />}
              </div>
            </motion.div>
          </AnimatePresence>
        </div>
      </div>

      {/* Queue of other staged titles */}
      <ol ref={railRef} onWheel={hold} onTouchMove={hold} className="scroll-x flex gap-2 lg:flex-col lg:gap-1">
        {staged.map((item, position) => {
          const active = position === index
          return (
            <li key={item.id} className="shrink-0 lg:shrink">
              <button
                type="button"
                onPointerEnter={() => setIndex(position)}
                onFocus={() => setIndex(position)}
                onClick={() => (active ? open(item) : setIndex(position))}
                aria-current={active || undefined}
                className={cn(
                  "relative flex w-64 items-center gap-3 rounded-[0.875rem] p-2 pr-3 text-left transition-colors duration-200 lg:w-full",
                  active ? "bg-surface shadow-ring" : "hover:bg-surface/60",
                )}
              >
                {active && <motion.span layoutId="spotlight-marker" transition={SPRING_SNAP} className="absolute inset-y-3 left-0 w-1 rounded-full bg-signal" />}
                {active && autoplay && (
                  <span
                    key={index}
                    aria-hidden
                    onAnimationEnd={advance}
                    style={{ animation: `fill ${ADVANCE_MS}ms linear forwards`, animationPlayState: paused ? "paused" : "running" }}
                    className="absolute inset-x-3 bottom-0 h-0.5 origin-left rounded-full bg-signal"
                  />
                )}
                <Poster path={item.posterPath} title={item.title} size="thumb" className="w-11 shrink-0 rounded-[0.375rem]" />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm font-semibold text-ink">{item.title}</span>
                  <span className="block text-micro text-ink-3">
                    <span className="font-mono tabular">{item.year}</span> · {item.mediaType === "tv" ? "Series" : "Film"}
                  </span>
                </span>
                {item.voteAverage > 0 && (
                  <span className="inline-flex items-center gap-1 font-mono text-micro text-ink-2 tabular">
                    <StarIcon aria-hidden weight="fill" className="size-3 text-signal-strong" />
                    {item.voteAverage.toFixed(1)}
                  </span>
                )}
              </button>
            </li>
          )
        })}
      </ol>
    </section>
  )
}

/* -------------------------------------------------------------------------- */
/* Scoped hooks                                                               */
/* -------------------------------------------------------------------------- */

/**
 * A hold that lapses on its own: calling `hold` makes `held` true until
 * `duration` passes without another call.
 */
function useHold(duration: number): [boolean, () => void] {
  const [held, setHeld] = React.useState(false)
  const timer = React.useRef<number | undefined>(undefined)

  const hold = React.useCallback(() => {
    setHeld(true)
    window.clearTimeout(timer.current)
    timer.current = window.setTimeout(() => setHeld(false), duration)
  }, [duration])

  React.useEffect(() => () => window.clearTimeout(timer.current), [])
  return [held, hold]
}

/** Whether any part of an element is inside the viewport. */
function useOnScreen(ref: React.RefObject<HTMLElement | null>): boolean {
  const [onScreen, setOnScreen] = React.useState(true)

  React.useEffect(() => {
    const node = ref.current
    if (!node) return
    const observer = new IntersectionObserver(([entry]) => setOnScreen(entry.isIntersecting))
    observer.observe(node)
    return () => observer.disconnect()
  }, [ref])

  return onScreen
}

/** Whether the page's tab is the one being shown. */
function usePageVisible(): boolean {
  return React.useSyncExternalStore(
    (onChange) => {
      document.addEventListener("visibilitychange", onChange)
      return () => document.removeEventListener("visibilitychange", onChange)
    },
    () => document.visibilityState === "visible",
  )
}
