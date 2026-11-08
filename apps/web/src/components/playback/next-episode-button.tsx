import * as React from "react"
import { motion } from "motion/react"
import { SkipForwardIcon } from "@phosphor-icons/react"
import { UP_NEXT_COUNTDOWN_MS } from "@findr/types/playback"
import { FADE } from "@/lib/motion"
import { cn } from "@/lib/utils"

interface NextEpisodeButtonProps {
  /** The next episode's code, as in S01E02, for its accessible name. */
  code: string
  onClick: () => void
  /**
   * Count down here and call `onDone` at the end, held while `held`. The
   * countdown is a CSS animation, so it keeps time without re-rendering, and
   * keeps its length under reduced motion.
   */
  countdown?: { held: boolean; onDone: () => void }
  /** Or show a countdown run elsewhere, as 0–1 (the TV's, from the server). */
  progress?: number
  className?: string
}

/**
 * The one control offered at the credits: Next Episode, as a glass pill over
 * the picture. A countdown is an amber fill sweeping through it, the label
 * turning dark as the fill passes; without one it is a plain button.
 */
export function NextEpisodeButton({ code, onClick, countdown, progress, className }: NextEpisodeButtonProps) {
  const fill: React.CSSProperties = countdown
    ? ({ "--countdown": `${UP_NEXT_COUNTDOWN_MS}ms`, animationPlayState: countdown.held ? "paused" : "running" } as React.CSSProperties)
    : progress !== undefined
      ? { clipPath: `inset(0 ${(1 - Math.min(1, Math.max(0, progress))) * 100}% 0 0)`, transition: "clip-path 1s linear" }
      : { clipPath: "inset(0 100% 0 0)" }

  return (
    <motion.button
      type="button"
      onClick={onClick}
      aria-label={`Next episode, ${code}`}
      title={code}
      initial={{ opacity: 0, y: 12 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, y: 12 }}
      transition={FADE}
      className={cn(
        "isolate inline-grid h-13 overflow-hidden rounded-full text-base font-semibold text-surface",
        "bg-[oklch(0.2_0.012_265/0.72)] shadow-[inset_0_0_0_1px_oklch(1_0_0/0.14),0_18px_40px_-18px_oklch(0_0_0/0.7)] backdrop-blur-xl backdrop-saturate-150",
        "transition-[box-shadow,scale] duration-150 ease-out hover:shadow-[inset_0_0_0_1px_oklch(1_0_0/0.3),0_18px_40px_-18px_oklch(0_0_0/0.7)] active:scale-[0.98]",
        "focus-visible:outline-2 focus-visible:outline-offset-3 focus-visible:outline-signal",
        className,
      )}
    >
      <Label />
      <span
        aria-hidden
        className={cn("col-start-1 row-start-1 bg-signal text-ink", countdown && "next-episode-countdown")}
        style={fill}
        onAnimationEnd={countdown ? (event) => event.animationName === "next-episode-sweep" && countdown.onDone() : undefined}
      >
        <Label />
      </span>
    </motion.button>
  )
}

/** The icon and words, drawn twice: light on the glass, dark on the fill. */
function Label() {
  return (
    <span className="col-start-1 row-start-1 flex h-full items-center gap-2.5 whitespace-nowrap pl-[1.125rem] pr-[1.375rem]">
      <SkipForwardIcon aria-hidden weight="fill" className="size-5" />
      Next Episode
    </span>
  )
}
