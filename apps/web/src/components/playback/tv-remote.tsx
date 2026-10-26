import * as React from "react"
import { AnimatePresence, motion } from "motion/react"
import {
  ArrowCounterClockwiseIcon,
  ArrowLeftIcon,
  DeviceMobileIcon,
  FastForwardIcon,
  PauseIcon,
  PlayIcon,
  RewindIcon,
  SkipForwardIcon,
  SpeakerHighIcon,
  SpeakerSlashIcon,
  TelevisionSimpleIcon,
  TranslateIcon,
} from "@phosphor-icons/react"
import type { PlaybackItemKey, RendererCommand, RendererRecord, RendererStatus } from "@findr/types/playback"
import { commandRenderer, fetchRendererStatus, playOnRenderer } from "@/lib/api"
import { EASE_OUT } from "@/lib/motion"
import { audioTrackDetail, audioTrackLabel, castActive, formatClock, sameItem } from "@/lib/playback"
import { cn } from "@/lib/utils"
import { Button } from "@/components/ui/button"
import { Spinner } from "@/components/ui/spinner"
import { PlayerMessage } from "@/components/playback/player"
import { Panel, PanelDetail, PanelGroup, PanelOption } from "@/components/playback/player-panel"

/**
 * The remote for a DLNA TV. Findr's server drives the TV; this page sends it
 * commands and shows what it reports: position, play state and volume. The
 * TV keeps playing when the page is left, and "Watch here" stops it and
 * carries on in the browser from the same moment. Opened on a TV already
 * playing this for the same user, it rejoins it rather than starting again,
 * unless told to restart. A file with several audio tracks can be switched
 * from here, which sends the TV the video again from where it is.
 *
 * Keyboard: Space or K plays and pauses, the left and right arrows (or J and
 * L) skip back and forward, the up and down arrows change the TV's volume,
 * M mutes, and Escape goes back, leaving the TV playing.
 */

interface TvRemoteProps {
  renderer: RendererRecord
  item: PlaybackItemKey
  /** Where to start on the TV. */
  startMs: number
  /** Send it again even when the TV already plays it, as for Start over. */
  restart: boolean
  /** The audio track to start with; null lets the server pick by preference. */
  audioTrack: number | null
  title: string
  subtitle: string | null
  backdrop: string | null
  next: { key: PlaybackItemKey; label: string } | null
  onWatchHere: (positionMs: number) => void
  onPlayNext: () => void
  onExit: () => void
}

/** How often the TV's state is read while the remote is open. */
const POLL_MS = 1000

/** Seconds the skip buttons move. */
const SKIP_BACK_MS = 10_000
const SKIP_FORWARD_MS = 30_000

/** How much the arrow keys change the TV's volume. */
const VOLUME_STEP = 5

/** Past this share of the runtime a stopped TV counts as finished. */
const FINISHED_SHARE = 0.9

export function TvRemote(props: TvRemoteProps) {
  const { renderer, item, startMs, restart, title, subtitle } = props
  const [audioTrack, setAudioTrack] = React.useState(props.audioTrack)
  const [audioOpen, setAudioOpen] = React.useState(false)
  const closeAudio = React.useCallback(() => setAudioOpen(false), [])
  const [status, setStatus] = React.useState<RendererStatus | null>(null)
  const [error, setError] = React.useState<string | null>(null)
  const [attempt, setAttempt] = React.useState(0)
  const [pending, setPending] = React.useState(false)
  /** The position being dragged to, shown in place of the TV's until released. */
  const [scrub, setScrub] = React.useState<number | null>(null)
  const lastPosition = React.useRef(startMs)
  /** Whether the TV has started; some report STOPPED while still loading. */
  const started = React.useRef(false)

  // Rejoin the TV if it already plays this for us, else send the video to it; then follow it
  React.useEffect(() => {
    let cancelled = false
    setStatus(null)
    setError(null)
    started.current = false
    const label = subtitle ? `${title} ${subtitle}` : title
    const begin = async () => {
      if (attempt === 0 && !restart) {
        const current = await fetchRendererStatus(renderer.id).catch(() => null)
        if (current?.mine && sameItem(current.item, item) && castActive(current)) return current
      }
      return playOnRenderer(renderer.id, { ...item, startMs: attempt === 0 ? startMs : lastPosition.current, audioTrack, label })
    }
    begin()
      .then((next) => {
        if (!cancelled) setStatus(next)
      })
      .catch((reason: unknown) => {
        if (!cancelled) setError(reason instanceof Error ? reason.message : "The TV didn't start playing.")
      })
    return () => {
      cancelled = true
    }
  }, [renderer.id, item, startMs, restart, audioTrack, title, subtitle, attempt])

  const connected = status !== null
  React.useEffect(() => {
    if (!connected) return
    const controller = new AbortController()
    const timer = setInterval(() => {
      fetchRendererStatus(renderer.id, { signal: controller.signal })
        .then(setStatus)
        .catch(() => {})
    }, POLL_MS)
    return () => {
      clearInterval(timer)
      controller.abort()
    }
  }, [connected, renderer.id])

  // Findr let the TV go (it stopped for a while, vanished, or someone else took it)
  const ours = status?.item?.titleId === item.titleId && status.item.season === item.season && status.item.episode === item.episode
  if (status && ours && status.positionMs > 0) lastPosition.current = status.positionMs
  if (status && ours && (status.state === "playing" || status.state === "paused")) started.current = true
  const durationMs = status?.durationMs || 1
  const finished = lastPosition.current >= durationMs * FINISHED_SHARE
  // A TV still starting is about to play, so the control offers Pause
  const playing = status?.state === "playing" || status?.state === "loading"
  const position = scrub ?? (ours ? status?.positionMs ?? lastPosition.current : lastPosition.current)
  // The audio track the TV plays, offered for switching when there are others
  const playingTrack = status?.audioTrack != null ? status.audioTracks[status.audioTrack] : undefined
  const stopped =
    status !== null && (!ours || status.state === "unreachable" || (started.current && (status.state === "stopped" || status.state === "idle")))

  /** Sends the video to the TV again, from the top once it had finished. */
  function playAgain() {
    if (finished) lastPosition.current = 0
    setAttempt((current) => current + 1)
  }

  /** Sends the video again in another language, from where the TV is. */
  function chooseAudio(index: number) {
    setAudioOpen(false)
    if (index === status?.audioTrack) return
    setAudioTrack(index)
    setAttempt((current) => current + 1)
  }

  async function send(command: RendererCommand) {
    setPending(true)
    try {
      setStatus(await commandRenderer(renderer.id, command))
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "The TV didn't answer.")
    } finally {
      setPending(false)
    }
  }

  async function watchHere() {
    await commandRenderer(renderer.id, { action: "stop" }).catch(() => {})
    props.onWatchHere(lastPosition.current)
  }

  function seekTo(positionMs: number) {
    const target = Math.min(Math.max(positionMs, 0), Math.max(durationMs - 1000, 0))
    lastPosition.current = target
    void send({ action: "seek", positionMs: target })
  }

  // Keyboard shortcuts, read through a ref so the listener sees this render's state
  const ready = status !== null && !stopped
  const shortcuts = React.useRef<(event: KeyboardEvent) => void>(() => {})
  shortcuts.current = (event) => {
    if (event.metaKey || event.ctrlKey || event.altKey || ownsKey(event)) return
    const key = event.key.length === 1 ? event.key.toLowerCase() : event.key
    const volume = status?.volume ?? null
    let handled = true
    if (key === "Escape") props.onExit()
    else if (!ready) handled = false
    else if (key === " " || key === "k") {
      if (!pending) void send({ action: playing ? "pause" : "play" })
    } else if (key === "ArrowLeft" || key === "j") seekTo(position - SKIP_BACK_MS)
    else if (key === "ArrowRight" || key === "l") seekTo(position + SKIP_FORWARD_MS)
    else if ((key === "ArrowUp" || key === "ArrowDown") && volume !== null) {
      void send({ action: "volume", volume: Math.min(Math.max(volume + (key === "ArrowUp" ? VOLUME_STEP : -VOLUME_STEP), 0), 100) })
    } else if (key === "m" && volume !== null) void send({ action: "mute", muted: !status?.muted })
    else handled = false
    if (handled) event.preventDefault()
  }
  React.useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => shortcuts.current(event)
    window.addEventListener("keydown", onKeyDown)
    return () => window.removeEventListener("keydown", onKeyDown)
  }, [])

  if (error && !status) {
    return (
      <div className="fixed inset-0 bg-[oklch(0.13_0.01_265)] text-surface">
        <PlayerMessage
          title={`Couldn't play on ${renderer.name}`}
          description={error}
          onExit={props.onExit}
          action={
            <>
              <Button variant="signal" onClick={playAgain}>
                Try again
              </Button>
              <Button variant="ghost" icon={DeviceMobileIcon} className="text-surface/80 hover:bg-surface/10 hover:text-surface" onClick={() => props.onWatchHere(lastPosition.current)}>
                Watch here
              </Button>
            </>
          }
        />
      </div>
    )
  }

  return (
    <div className="fixed inset-0 overflow-hidden bg-[oklch(0.13_0.01_265)] text-surface">
      {props.backdrop && <img src={props.backdrop} alt="" className="absolute inset-0 size-full object-cover opacity-30" />}
      <div className="absolute inset-0 bg-gradient-to-t from-[oklch(0.13_0.01_265)] via-[oklch(0.13_0.01_265/0.7)] to-[oklch(0.13_0.01_265/0.4)]" />

      {/* Top bar: back leaves the TV playing */}
      <div className="absolute inset-x-0 top-0 flex items-center gap-3 px-4 pt-4 md:px-6 md:pt-5">
        <button
          type="button"
          aria-label="Back, leaving the TV playing"
          aria-keyshortcuts="Escape"
          onClick={props.onExit}
          className="flex size-10 shrink-0 items-center justify-center rounded-full bg-surface/12 text-surface backdrop-blur-md transition-[background-color,transform] hover:bg-surface/20 active:scale-90"
        >
          <ArrowLeftIcon weight="bold" className="size-5" />
        </button>
        <span className="inline-flex h-9 min-w-0 items-center gap-2 rounded-full bg-surface/12 px-3.5 text-[0.8125rem] font-medium backdrop-blur-md">
          <TelevisionSimpleIcon aria-hidden weight="fill" className="size-4 shrink-0 text-signal" />
          <span className="truncate">{renderer.name}</span>
        </span>
        {status && ours && !stopped && playingTrack && status.audioTracks.length > 1 && (
          <button
            type="button"
            aria-label="Audio track"
            aria-expanded={audioOpen}
            onClick={() => setAudioOpen((open) => !open)}
            className={cn(
              "ml-auto inline-flex h-10 min-w-0 shrink items-center gap-2 rounded-full px-4 text-[0.8125rem] font-medium backdrop-blur-md transition-[background-color,transform] active:scale-95",
              audioOpen ? "bg-signal text-ink" : "bg-surface/12 text-surface hover:bg-surface/20",
            )}
          >
            <TranslateIcon aria-hidden weight="bold" className="size-4 shrink-0" />
            <span className="truncate">{audioTrackLabel(playingTrack, status.audioTracks)}</span>
          </button>
        )}
      </div>

      <AnimatePresence>
        {audioOpen && status && (
          <Panel label="Audio track" onClose={closeAudio}>
            <PanelGroup label="Audio">
              {status.audioTracks.map((track) => (
                <PanelOption key={track.index} selected={status.audioTrack === track.index} onClick={() => chooseAudio(track.index)}>
                  <span className="truncate">{audioTrackLabel(track, status.audioTracks)}</span>
                  <PanelDetail>{audioTrackDetail(track)}</PanelDetail>
                </PanelOption>
              ))}
            </PanelGroup>
          </Panel>
        )}
      </AnimatePresence>

      <motion.div
        initial={{ opacity: 0, y: 12 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.45, ease: EASE_OUT }}
        className="absolute inset-x-0 bottom-0 mx-auto max-w-[1600px] px-6 pb-12 md:px-12 md:pb-16"
      >
        {subtitle && <p className="font-mono text-[0.8125rem] text-surface/70 tabular">{subtitle}</p>}
        <h1 className="display mt-1 max-w-3xl text-4xl md:text-6xl">{title}</h1>
        <p className="mt-3 text-[0.9375rem] text-surface/70" aria-live="polite">
          {describe(status, ours, stopped, renderer.name)}
        </p>

        {/* Scrubber */}
        <div className="mt-6 max-w-3xl">
          <input
            type="range"
            aria-label="Position"
            min={0}
            max={durationMs}
            step={1000}
            value={Math.min(position, durationMs)}
            disabled={!status || stopped}
            onChange={(event) => setScrub(Number(event.target.value))}
            onPointerUp={() => {
              if (scrub !== null) seekTo(scrub)
              setScrub(null)
            }}
            onKeyUp={(event) => {
              if (scrub !== null && (event.key.startsWith("Arrow") || event.key === "Home" || event.key === "End")) {
                seekTo(scrub)
                setScrub(null)
              }
            }}
            style={{ "--fill": `${(Math.min(position, durationMs) / durationMs) * 100}%` } as React.CSSProperties}
            className={RANGE_CLASS}
          />
          <div className="mt-2 flex justify-between font-mono text-micro text-surface/60 tabular">
            <span>{formatClock(position)}</span>
            <span>-{formatClock(Math.max(durationMs - position, 0))}</span>
          </div>
        </div>

        {stopped ? (
          <div className="mt-6 flex flex-wrap gap-3">
            {finished && props.next ? (
              <Button variant="signal" size="lg" icon={SkipForwardIcon} onClick={props.onPlayNext}>
                Play {props.next.label} on TV
              </Button>
            ) : (
              <Button variant="signal" size="lg" icon={ArrowCounterClockwiseIcon} onClick={playAgain}>
                {finished ? "Play again on TV" : "Resume on TV"}
              </Button>
            )}
            <Button variant="ghost" size="lg" icon={DeviceMobileIcon} className="text-surface/85 hover:bg-surface/10 hover:text-surface" onClick={() => props.onWatchHere(finished ? 0 : lastPosition.current)}>
              Watch here
            </Button>
          </div>
        ) : (
          <div className="mt-6 flex flex-wrap items-center gap-x-6 gap-y-4">
            <div className="flex items-center gap-2">
              <RoundButton label="Back 10 seconds" shortcut="ArrowLeft J" disabled={!status} onClick={() => seekTo(position - SKIP_BACK_MS)}>
                <RewindIcon weight="fill" className="size-5" />
              </RoundButton>
              <button
                type="button"
                aria-label={playing ? "Pause" : "Play"}
                aria-keyshortcuts="Space K"
                disabled={!status || pending}
                onClick={() => void send({ action: playing ? "pause" : "play" })}
                className="flex size-16 items-center justify-center rounded-full bg-signal text-ink shadow-float transition-transform hover:scale-105 active:scale-95 disabled:opacity-60"
              >
                {!status ? <Spinner className="size-6" /> : playing ? <PauseIcon weight="fill" className="size-7" /> : <PlayIcon weight="fill" className="ml-0.5 size-7" />}
              </button>
              <RoundButton label="Forward 30 seconds" shortcut="ArrowRight L" disabled={!status} onClick={() => seekTo(position + SKIP_FORWARD_MS)}>
                <FastForwardIcon weight="fill" className="size-5" />
              </RoundButton>
            </div>

            {status?.volume != null && <Volume volume={status.volume} muted={status.muted} onVolume={(volume) => void send({ action: "volume", volume })} onMute={(muted) => void send({ action: "mute", muted })} />}

            <Button variant="ghost" icon={DeviceMobileIcon} className="text-surface/85 hover:bg-surface/10 hover:text-surface sm:ml-auto" onClick={() => void watchHere()}>
              Watch here
            </Button>
          </div>
        )}

        {error && status && <p className="mt-4 text-[0.875rem] text-[oklch(0.78_0.14_35)]">{error}</p>}
      </motion.div>
    </div>
  )
}

/** One line on what the TV is doing. */
function describe(status: RendererStatus | null, ours: boolean, stopped: boolean, name: string): string {
  if (!status) return `Connecting to ${name}`
  if (status.state === "unreachable") return `${name} stopped answering.`
  if (!ours) return `${name} is no longer playing this.`
  if (stopped) return `Stopped on ${name}.`
  if (status.state === "loading") return `Starting on ${name}`
  return `${status.state === "paused" ? "Paused" : "Playing"} on ${name}.`
}

/** A native range input drawn as a pill track with a signal fill. */
const RANGE_CLASS = cn(
  "h-6 w-full cursor-pointer appearance-none bg-transparent disabled:cursor-default disabled:opacity-50",
  "[&::-webkit-slider-runnable-track]:h-1.5 [&::-webkit-slider-runnable-track]:rounded-full",
  "[&::-webkit-slider-runnable-track]:bg-[linear-gradient(to_right,var(--color-signal)_var(--fill),oklch(1_0_0/0.18)_var(--fill))]",
  "[&::-webkit-slider-thumb]:-mt-[5px] [&::-webkit-slider-thumb]:size-4 [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:rounded-full [&::-webkit-slider-thumb]:bg-surface [&::-webkit-slider-thumb]:shadow-float",
  "[&::-moz-range-track]:h-1.5 [&::-moz-range-track]:rounded-full [&::-moz-range-track]:bg-surface/20",
  "[&::-moz-range-progress]:h-1.5 [&::-moz-range-progress]:rounded-full [&::-moz-range-progress]:bg-signal",
  "[&::-moz-range-thumb]:size-4 [&::-moz-range-thumb]:rounded-full [&::-moz-range-thumb]:border-0 [&::-moz-range-thumb]:bg-surface",
)

/**
 * Whether the focused control handles this key itself: typing in a field,
 * arrows on a slider, Space or Enter on a button.
 */
function ownsKey(event: KeyboardEvent): boolean {
  const target = event.target
  if (!(target instanceof HTMLElement)) return false
  if (target.isContentEditable || target instanceof HTMLTextAreaElement || target instanceof HTMLSelectElement) return true
  if (target instanceof HTMLInputElement) return target.type !== "range" || event.key.startsWith("Arrow") || event.key === "Home" || event.key === "End"
  return target instanceof HTMLButtonElement && (event.key === " " || event.key === "Enter")
}

function RoundButton({ label, shortcut, disabled, onClick, children }: { label: string; shortcut?: string; disabled?: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      type="button"
      aria-label={label}
      aria-keyshortcuts={shortcut}
      disabled={disabled}
      onClick={onClick}
      className="flex size-12 items-center justify-center rounded-full bg-surface/12 text-surface backdrop-blur-md transition-[background-color,transform] hover:bg-surface/20 active:scale-90 disabled:opacity-50"
    >
      {children}
    </button>
  )
}

interface VolumeProps {
  volume: number
  muted: boolean
  onVolume: (volume: number) => void
  onMute: (muted: boolean) => void
}

/** The TV's volume, sent when the slider is let go. */
function Volume({ volume, muted, onVolume, onMute }: VolumeProps) {
  const [draft, setDraft] = React.useState<number | null>(null)
  const shown = draft ?? volume

  return (
    <div className="flex items-center gap-2">
      <RoundButton label={muted ? "Unmute TV" : "Mute TV"} shortcut="M" onClick={() => onMute(!muted)}>
        {muted ? <SpeakerSlashIcon weight="fill" className="size-5" /> : <SpeakerHighIcon weight="fill" className="size-5" />}
      </RoundButton>
      <input
        type="range"
        aria-label="TV volume"
        min={0}
        max={100}
        value={shown}
        onChange={(event) => setDraft(Number(event.target.value))}
        onPointerUp={() => {
          if (draft !== null) onVolume(draft)
          setDraft(null)
        }}
        onKeyUp={() => {
          if (draft !== null) onVolume(draft)
          setDraft(null)
        }}
        style={{ "--fill": `${shown}%` } as React.CSSProperties}
        className={cn(RANGE_CLASS, "w-32", muted && "opacity-50")}
      />
    </div>
  )
}
