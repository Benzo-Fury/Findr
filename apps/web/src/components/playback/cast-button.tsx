import * as React from "react"
import { useNavigate } from "react-router-dom"
import { Popover } from "@base-ui/react/popover"
import { AnimatePresence, motion } from "motion/react"
import { ArrowUpRightIcon, CheckIcon, DevicesIcon, PauseIcon, PlayIcon, StopIcon, TelevisionSimpleIcon } from "@phosphor-icons/react"
import type { RendererCommand, RendererRecord, RendererStatus } from "@findr/types/playback"
import { commandRenderer, hideRendererSplash, showRendererSplash } from "@/lib/api"
import { EASE_OUT, SPRING_SNAP } from "@/lib/motion"
import { castActive, formatClock, usePlayback, watchPath } from "@/lib/playback"
import { rendererDetail, useRenderers } from "@/lib/renderers"
import { cn } from "@/lib/utils"
import { Button } from "@/components/ui/button"
import { ProgressBar } from "@/components/ui/progress-bar"
import { Spinner } from "@/components/ui/spinner"

interface CastButtonProps {
  /** Show it even while nothing plays on a TV, as the Library does; other pages show it only then. */
  pinned: boolean
}

/**
 * The cast control, floating in the bottom corner (above the phone tab bar)
 * so it stays in reach while scrolling. Picking a TV here, before anything
 * plays, makes every Play button start on that TV straight away; "This
 * device" plays in the browser again. The picked TV shows Findr's splash
 * until something plays, and the one let go is cleared. Lit amber, with the
 * TV's name, while a TV is picked.
 *
 * While a TV plays something this user started, it says what and where, on
 * every page, and its menu leads back to that TV's remote, with play, pause
 * and stop at hand. Renders nothing while casting is off.
 */
export function CastButton({ pinned }: CastButtonProps) {
  const { casting, castTarget, setCastTarget, casts } = usePlayback()
  const [open, setOpen] = React.useState(false)
  const now = casts.find(castActive) ?? null

  if (!casting || (!pinned && !now)) return null
  const lit = now !== null || castTarget !== null

  return (
    <Popover.Root open={open} onOpenChange={setOpen}>
      <Popover.Trigger
        aria-label={now ? `${now.label ?? "Video"}, ${castVerb(now).toLowerCase()} on ${now.renderer.name}` : castTarget ? `Playing on ${castTarget.name}` : "Play on a TV"}
        render={<motion.button initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.3, ease: EASE_OUT }} />}
        className={cn(
          "fixed bottom-[calc(var(--tabs-height)+env(safe-area-inset-bottom)+1rem)] right-4 z-[var(--z-chrome)] flex h-12 items-center gap-2 rounded-full text-sm font-semibold shadow-float transition-[background-color,box-shadow,color,transform] duration-200 active:scale-95 md:bottom-6 md:right-8",
          now ? "max-w-[min(19rem,calc(100vw-2rem))] pl-2 pr-5" : "max-w-[min(16rem,calc(100vw-2rem))] pl-4 pr-5",
          lit ? "bg-signal text-ink hover:bg-signal-strong" : "bg-surface text-ink ring-1 ring-line hover:ring-line-strong",
        )}
      >
        {now ? (
          <>
            <span className="flex size-8 shrink-0 items-center justify-center rounded-full bg-ink/10">
              <TelevisionSimpleIcon aria-hidden weight="fill" className="size-4" />
            </span>
            <span className="min-w-0 text-left">
              <span className="block truncate leading-tight">{now.label ?? "Video"}</span>
              <span className="block truncate text-micro font-medium text-ink/70">
                {castVerb(now)} on {now.renderer.name}
              </span>
            </span>
          </>
        ) : (
          <>
            <TelevisionSimpleIcon weight={castTarget ? "fill" : "bold"} className="size-5 shrink-0" />
            <span className="truncate">{castTarget ? castTarget.name : "Cast"}</span>
          </>
        )}
      </Popover.Trigger>
      <AnimatePresence>
        {open && (
          <Popover.Portal keepMounted>
            <Popover.Positioner side="top" sideOffset={10} align="end" className="z-[var(--z-overlay)] outline-none">
              <Popover.Popup
                render={
                  <motion.div
                    initial={{ opacity: 0, scale: 0.94, y: 4 }}
                    animate={{ opacity: 1, scale: 1, y: 0 }}
                    exit={{ opacity: 0, scale: 0.96, y: 2 }}
                    transition={SPRING_SNAP}
                  />
                }
                className="w-[min(20rem,calc(100vw-2rem))] origin-[var(--transform-origin)] rounded-panel bg-surface p-1.5 shadow-float outline-none ring-1 ring-line"
              >
                {now && <NowPlaying status={now} onDone={() => setOpen(false)} />}
                <CastTargets
                  target={castTarget}
                  onPick={(renderer) => {
                    if (renderer?.id !== castTarget?.id) {
                      if (castTarget) void hideRendererSplash(castTarget.id).catch(() => {})
                      if (renderer) void showRendererSplash(renderer.id).catch(() => {})
                    }
                    setCastTarget(renderer)
                    setOpen(false)
                  }}
                />
              </Popover.Popup>
            </Popover.Positioner>
          </Popover.Portal>
        )}
      </AnimatePresence>
    </Popover.Root>
  )
}

/** What a TV is doing with what it was sent, as a word. */
function castVerb(status: RendererStatus): string {
  return status.state === "paused" ? "Paused" : status.state === "loading" ? "Starting" : "Playing"
}

interface NowPlayingProps {
  status: RendererStatus
  /** Closes the menu, after leaving for the remote or stopping. */
  onDone: () => void
}

/** What plays on the TV, how far in, and the way back to its remote. */
function NowPlaying({ status, onDone }: NowPlayingProps) {
  const navigate = useNavigate()
  const { refreshCasts } = usePlayback()
  const [pending, setPending] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)
  // A TV still starting is about to play, so the control offers Pause
  const playing = status.state === "playing" || status.state === "loading"
  const known = status.durationMs > 0

  async function send(command: RendererCommand) {
    setPending(true)
    setError(null)
    try {
      await commandRenderer(status.renderer.id, command)
      refreshCasts()
      if (command.action === "stop") onDone()
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "The TV didn't answer.")
    } finally {
      setPending(false)
    }
  }

  function openRemote() {
    if (!status.item) return
    const path = watchPath(status.item)
    onDone()
    navigate(`${path}${path.includes("?") ? "&" : "?"}tv=${encodeURIComponent(status.renderer.id)}`)
  }

  return (
    <div className="mb-1.5 rounded-[0.875rem] bg-sunken px-3.5 pb-3.5 pt-3">
      <p className="truncate text-micro font-semibold text-ink-3">
        {castVerb(status)} on {status.renderer.name}
      </p>
      <p className="mt-0.5 truncate text-[0.9375rem] font-semibold text-ink">{status.label ?? "Video"}</p>
      {known && (
        <>
          <ProgressBar value={status.positionMs / status.durationMs} label="Played so far" size="hair" className="mt-3" />
          <div className="mt-1.5 flex justify-between font-mono text-micro text-ink-3 tabular">
            <span>{formatClock(status.positionMs)}</span>
            <span>-{formatClock(Math.max(status.durationMs - status.positionMs, 0))}</span>
          </div>
        </>
      )}
      <div className="mt-3 flex items-center gap-2">
        <Button variant="signal" size="sm" iconEnd={ArrowUpRightIcon} onClick={openRemote} disabled={!status.item}>
          Open remote
        </Button>
        <Button
          variant="outline"
          size="sm"
          iconOnly
          icon={playing ? PauseIcon : PlayIcon}
          aria-label={playing ? "Pause on TV" : "Play on TV"}
          disabled={pending}
          onClick={() => void send({ action: playing ? "pause" : "play" })}
        />
        <Button variant="ghost" size="sm" iconOnly icon={StopIcon} aria-label="Stop the TV" disabled={pending} onClick={() => void send({ action: "stop" })} />
      </div>
      {error && <p className="mt-2 text-micro text-bad">{error}</p>}
    </div>
  )
}

interface CastTargetsProps {
  target: RendererRecord | null
  onPick: (renderer: RendererRecord | null) => void
}

/** This browser, then the TVs found on the network, with the picked one ticked. */
function CastTargets({ target, onPick }: CastTargetsProps) {
  const { renderers, error, searching, search } = useRenderers()

  // The picked TV stays listed while a search runs or when it doesn't answer
  const listed = renderers ?? []
  const shown = target && !listed.some((renderer) => renderer.id === target.id) ? [target, ...listed] : listed

  return (
    <div>
      <div className="flex items-center justify-between px-3 pb-1 pt-1.5">
        <p className="text-micro font-semibold text-ink-3">Play on</p>
        <button
          type="button"
          onClick={() => void search(true)}
          disabled={searching}
          className="rounded-full px-2 py-1 text-micro font-semibold text-ink-2 transition-colors hover:bg-sunken hover:text-ink disabled:opacity-50"
        >
          {searching ? "Searching" : "Search again"}
        </button>
      </div>

      <div role="radiogroup" aria-label="Play on">
        <Target icon={DevicesIcon} name="This device" detail={null} selected={target === null} onClick={() => onPick(null)} />
        {shown.map((renderer) => (
          <Target
            key={renderer.id}
            icon={TelevisionSimpleIcon}
            name={renderer.name}
            detail={rendererDetail(renderer)}
            selected={target?.id === renderer.id}
            onClick={() => onPick(renderer)}
          />
        ))}
      </div>

      {renderers === null || (searching && listed.length === 0) ? (
        <div className="flex items-center gap-3 px-3 py-3 text-[0.875rem] text-ink-2">
          <Spinner className="size-4 text-signal-ink" />
          Looking for TVs
        </div>
      ) : (
        listed.length === 0 && (
          <p className="px-3 py-2.5 text-[0.8125rem] leading-relaxed text-ink-2">
            No TVs answered. A TV must be on, with DLNA or screen sharing turned on, and on the same network as the Findr server.
          </p>
        )
      )}
      {error && <p className="px-3 pb-2 text-micro text-bad">{error}</p>}
    </div>
  )
}

interface TargetProps {
  icon: typeof TelevisionSimpleIcon
  name: string
  detail: string | null
  selected: boolean
  onClick: () => void
}

/** One place to play, as a radio row. */
function Target({ icon: TargetIcon, name, detail, selected, onClick }: TargetProps) {
  return (
    <button
      type="button"
      role="radio"
      aria-checked={selected}
      onClick={onClick}
      className="flex w-full items-center gap-3 rounded-[0.75rem] px-3 py-2.5 text-left transition-colors hover:bg-sunken"
    >
      <TargetIcon aria-hidden weight={selected ? "fill" : "duotone"} className={cn("size-5 shrink-0", selected ? "text-signal-ink" : "text-ink-2")} />
      <span className="min-w-0 flex-1">
        <span className="block truncate text-sm font-medium text-ink">{name}</span>
        {detail && <span className="block truncate text-micro text-ink-3">{detail}</span>}
      </span>
      {selected && <CheckIcon aria-hidden weight="bold" className="size-4 shrink-0 text-ink" />}
    </button>
  )
}
