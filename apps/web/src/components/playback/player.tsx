import * as React from "react"
import { AnimatePresence, motion } from "motion/react"
import { ArrowLeftIcon, CheckIcon, GearSixIcon, PlayIcon, TelevisionSimpleIcon, WarningCircleIcon, XIcon } from "@phosphor-icons/react"
import { Container } from "@videojs/react"
import { GoogleCast } from "@videojs/react/extensions/google-cast"
import { HlsJsVideo } from "@videojs/react/media/hlsjs-video"
import { VideoPlayer, VideoSkin, usePlayer } from "@videojs/react/video"
import "@videojs/react/video/skin.css"
import type { PlaybackItemKey, PlaybackPrefs, PlaybackSessionRecord, RendererRecord } from "@findr/types/playback"
import { createPlaybackSession, endPlaybackSession, reportPlaybackProgress, updatePlaybackPrefs } from "@/lib/api"
import { deviceProfile } from "@/lib/device-profile"
import { FADE } from "@/lib/motion"
import { usePlayback } from "@/lib/playback"
import { useRenderers } from "@/lib/renderers"
import { cn } from "@/lib/utils"
import { Button } from "@/components/ui/button"
import { Spinner } from "@/components/ui/spinner"
import { Switch } from "@/components/ui/switch"

/**
 * The video player for one movie or episode. It starts a session on the
 * server, plays its HLS stream with Video.js, reports progress as it goes,
 * and offers the next episode when one ends. Changing quality or audio starts
 * a fresh session at the same moment, since the server packages one stream
 * per session.
 *
 * Casting: the skin's Cast button sends a TV its own session through the
 * Google Cast extension, Safari's AirPlay button hands over the stream
 * itself (so Safari plays HLS natively there), and the TV button in the top
 * bar lists DLNA renderers, which Findr then drives from the server.
 */

interface PlayerProps {
  item: PlaybackItemKey
  /** Where to start, in milliseconds. */
  startMs: number
  title: string
  /** `S01E03`, for episodes. */
  subtitle: string | null
  posterUrl: string | null
  prefs: PlaybackPrefs
  onPrefs: (prefs: PlaybackPrefs) => void
  /** The next episode on disk, offered when this one ends. */
  next: { key: PlaybackItemKey; label: string } | null
  /** How many episodes in a row have started on their own, for the "still watching" check. */
  autoplayed: number
  onPlayNext: (automatic: boolean) => void
  /** Moves playback to a DLNA TV from where the player is. */
  onPlayOnTv: (renderer: RendererRecord, positionMs: number, audioTrack: number | null) => void
  onExit: () => void
}

/** HLS's MIME type, for Cast load requests and native playback. */
const HLS_TYPE = "application/vnd.apple.mpegurl"

/**
 * Whether this browser offers AirPlay. AirPlay hands the TV the stream's own
 * URL, which only works when Safari plays HLS itself rather than through
 * hls.js.
 */
const AIRPLAY = typeof window !== "undefined" && "WebKitPlaybackTargetAvailabilityEvent" in window

/** Whether the page was opened on this machine, so a relative URL would mean nothing to a TV. */
function openedLocally(): boolean {
  return ["localhost", "127.0.0.1", "[::1]"].includes(window.location.hostname)
}

/** Quality caps offered by hand, in bits per second; null sends the file as good as the device takes. */
const QUALITIES: { value: number | null; label: string }[] = [
  { value: null, label: "Best available" },
  { value: 20_000_000, label: "20 Mbps" },
  { value: 10_000_000, label: "10 Mbps" },
  { value: 6_000_000, label: "6 Mbps" },
  { value: 3_000_000, label: "3 Mbps" },
  { value: 1_500_000, label: "1.5 Mbps" },
]

/** The chosen quality is remembered per device. */
const QUALITY_KEY = "findr:playback-quality"

/** How often the position is reported while the player is open. */
const HEARTBEAT_MS = 10_000

/** Seconds before the next episode starts on its own. */
const COUNTDOWN_SECONDS = 10

/** Why the server re-encoded, in plain words. */
const REASONS: Record<string, string> = {
  bit_depth: "10-bit video",
  h264_level: "H.264 level above what the TV decodes",
  resolution: "resolution above this screen",
  hdr: "HDR on a non-HDR screen",
  bitrate_cap: "the quality limit",
}

function readQuality(): number | null {
  try {
    const stored = Number(localStorage.getItem(QUALITY_KEY))
    return QUALITIES.some((quality) => quality.value === stored) ? stored : null
  } catch {
    return null
  }
}

function describeMode(session: PlaybackSessionRecord): string {
  if (session.mode === "remux") return "Playing the original stream"
  const reasons = session.reasons.map((reason) => {
    const [kind, codec] = reason.split(":")
    if (kind === "audio_codec") return `${codec?.toUpperCase()} audio`
    if (kind === "video_codec") return `${codec?.toUpperCase()} video`
    return REASONS[reason] ?? reason
  })
  const what = session.mode === "audio" ? "Converting audio" : "Converting video"
  return reasons.length > 0 ? `${what} for ${reasons.join(", ")}` : what
}

export function Player(props: PlayerProps) {
  const { item, startMs } = props
  const { casting } = usePlayback()
  const [quality, setQuality] = React.useState<number | null>(readQuality)
  const [audioTrack, setAudioTrack] = React.useState<number | null>(null)
  const [session, setSession] = React.useState<PlaybackSessionRecord | null>(null)
  const [error, setError] = React.useState<string | null>(null)
  const [attempt, setAttempt] = React.useState(0)

  // The position to restart from when quality or audio changes, kept current by the player
  const positionRef = React.useRef(startMs)

  // One session per item, quality and audio choice; ending the old one frees its work
  React.useEffect(() => {
    let cancelled = false
    let started: PlaybackSessionRecord | null = null
    setSession(null)
    setError(null)

    createPlaybackSession({ ...item, deviceProfile: deviceProfile(), maxBitrate: quality, audioTrack, startMs: positionRef.current })
      .then((record) => {
        started = record
        if (cancelled) void endPlaybackSession(record.id).catch(() => {})
        else setSession(record)
      })
      .catch((reason: unknown) => {
        if (!cancelled) setError(reason instanceof Error ? reason.message : "Playback could not start.")
      })

    return () => {
      cancelled = true
      if (started) void endPlaybackSession(started.id).catch(() => {})
    }
  }, [item, quality, audioTrack, attempt])

  function chooseQuality(value: number | null) {
    try {
      if (value === null) localStorage.removeItem(QUALITY_KEY)
      else localStorage.setItem(QUALITY_KEY, String(value))
    } catch {
      // Remembering is a convenience only
    }
    setQuality(value)
  }

  function chooseAudio(index: number) {
    setAudioTrack(index)
    // Remember the language for everything else this user plays
    const language = session?.audioTracks[index]?.language
    if (language && language !== props.prefs.audioLanguage) {
      const prefs = { ...props.prefs, audioLanguage: language }
      props.onPrefs(prefs)
      void updatePlaybackPrefs(prefs).catch(() => {})
    }
  }

  return (
    <div className="fixed inset-0 bg-[oklch(0.13_0.01_265)] text-surface">
      {error ? (
        <PlayerMessage
          title="This can't play right now"
          description={error}
          onExit={props.onExit}
          action={<Button variant="signal" onClick={() => setAttempt((current) => current + 1)}>Try again</Button>}
        />
      ) : !session ? (
        <div className="flex size-full items-center justify-center">
          <Spinner className="size-8 text-signal" />
        </div>
      ) : (
        <VideoPlayer key={session.id}>
          <Container className="relative size-full">
            <VideoSkin
              className="size-full"
              style={
                {
                  "--media-accent-color": "var(--color-signal)",
                  "--media-accent-text-color": "var(--color-ink)",
                  "--media-font-family": "var(--font-sans)",
                  "--media-border-radius": "0",
                  "--media-border-color": "transparent",
                } as React.CSSProperties
              }
            >
              <HlsJsVideo
                {...(AIRPLAY
                  ? { source: { src: openedLocally() && session.remoteUrl ? session.remoteUrl : session.playlistUrl, type: HLS_TYPE, preferPlayback: "native" } }
                  : { src: session.playlistUrl })}
                autoPlay
                playsInline
                poster={props.posterUrl ?? undefined}
              >
                {session.trickplayUrl && <track kind="metadata" label="thumbnails" src={session.trickplayUrl} default />}
              </HlsJsVideo>
            </VideoSkin>
            {casting && session.castUrl && <GoogleCast src={session.castUrl} contentType={HLS_TYPE} streamType="on-demand" />}
            <Session
              {...props}
              casting={casting}
              audioTrack={audioTrack}
              session={session}
              positionRef={positionRef}
              quality={quality}
              onQuality={chooseQuality}
              onAudio={chooseAudio}
              onLost={() => setAttempt((current) => current + 1)}
            />
          </Container>
        </VideoPlayer>
      )}
    </div>
  )
}

/* -------------------------------------------------------------------------- */
/* Inside the player                                                          */
/* -------------------------------------------------------------------------- */

interface SessionProps extends PlayerProps {
  casting: boolean
  audioTrack: number | null
  session: PlaybackSessionRecord
  positionRef: React.RefObject<number>
  quality: number | null
  onQuality: (value: number | null) => void
  onAudio: (index: number) => void
  /** The stream failed; start a fresh session where it stopped. */
  onLost: () => void
}

/** Everything drawn over the video: the top bar, settings, and the next-episode offer. */
function Session(props: SessionProps) {
  const { session, item, positionRef } = props
  const store = usePlayer()
  const currentTime = usePlayer((state) => state.currentTime)
  const paused = usePlayer((state) => state.paused)
  const ended = usePlayer((state) => state.ended)
  const controlsVisible = usePlayer((state) => state.controlsVisible)
  const mediaError = usePlayer((state) => state.error)
  const [settingsOpen, setSettingsOpen] = React.useState(false)
  const [tvOpen, setTvOpen] = React.useState(false)

  // Keep the restart point current
  React.useEffect(() => {
    if (currentTime > 0) positionRef.current = Math.round(currentTime * 1000)
  }, [currentTime, positionRef])

  // A stream that fails mid-way, such as one reaped while the tab slept, restarts where it was
  const lostOnce = React.useRef(false)
  React.useEffect(() => {
    if (!mediaError || lostOnce.current) return
    lostOnce.current = true
    props.onLost()
  }, [mediaError, props])

  // Report the position on a steady beat, and on pause; the last report ends the session
  const report = React.useCallback(
    (event: "tick" | "pause" | "seek" | "stop", keepalive = false) => {
      void reportPlaybackProgress({ ...item, sessionId: session.id, positionMs: positionRef.current, event }, keepalive).catch(() => {})
    },
    [item, session.id, positionRef],
  )
  React.useEffect(() => {
    const timer = setInterval(() => report("tick"), HEARTBEAT_MS)
    const onHide = () => report("stop", true)
    window.addEventListener("pagehide", onHide)
    return () => {
      clearInterval(timer)
      window.removeEventListener("pagehide", onHide)
    }
  }, [report])
  React.useEffect(() => {
    if (paused && positionRef.current > 0) report("pause")
  }, [paused, report, positionRef])
  // Reaching the end marks it watched but keeps the session, so Watch again still plays
  React.useEffect(() => {
    if (ended) {
      positionRef.current = session.durationMs
      report("tick")
    }
  }, [ended, report, positionRef, session.durationMs])

  const chromeVisible = controlsVisible || paused || settingsOpen || tvOpen

  return (
    <>
      {/* Top bar: back, what is playing, settings */}
      <motion.div
        initial={false}
        animate={{ opacity: chromeVisible ? 1 : 0, y: chromeVisible ? 0 : -8 }}
        transition={FADE}
        className={cn(
          "absolute inset-x-0 top-0 flex items-start gap-3 bg-gradient-to-b from-[oklch(0.13_0.01_265/0.85)] to-transparent px-4 pb-16 pt-4 md:px-6 md:pt-5",
          !chromeVisible && "pointer-events-none",
        )}
      >
        <button
          type="button"
          aria-label="Back"
          onClick={props.onExit}
          className="flex size-10 shrink-0 items-center justify-center rounded-full bg-surface/12 text-surface backdrop-blur-md transition-[background-color,transform] hover:bg-surface/20 active:scale-90"
        >
          <ArrowLeftIcon weight="bold" className="size-5" />
        </button>
        <div className="min-w-0 flex-1 pt-0.5">
          <p className="heading truncate text-lg text-surface md:text-xl">{props.title}</p>
          {props.subtitle && <p className="font-mono text-micro text-surface/70 tabular">{props.subtitle}</p>}
        </div>
        {props.casting && (
          <button
            type="button"
            aria-label="Play on a TV"
            aria-expanded={tvOpen}
            onClick={() => {
              setSettingsOpen(false)
              setTvOpen((open) => !open)
            }}
            className={cn(
              "flex size-10 shrink-0 items-center justify-center rounded-full text-surface backdrop-blur-md transition-[background-color,transform] active:scale-90",
              tvOpen ? "bg-signal text-ink" : "bg-surface/12 hover:bg-surface/20",
            )}
          >
            <TelevisionSimpleIcon weight="bold" className="size-5" />
          </button>
        )}
        <button
          type="button"
          aria-label="Playback settings"
          aria-expanded={settingsOpen}
          onClick={() => {
            setTvOpen(false)
            setSettingsOpen((open) => !open)
          }}
          className={cn(
            "flex size-10 shrink-0 items-center justify-center rounded-full text-surface backdrop-blur-md transition-[background-color,transform] active:scale-90",
            settingsOpen ? "bg-signal text-ink" : "bg-surface/12 hover:bg-surface/20",
          )}
        >
          <GearSixIcon weight="bold" className="size-5" />
        </button>
      </motion.div>

      <AnimatePresence>
        {settingsOpen && (
          <SettingsPanel
            session={session}
            quality={props.quality}
            prefs={props.prefs}
            onQuality={(value) => {
              setSettingsOpen(false)
              props.onQuality(value)
            }}
            onAudio={(index) => {
              setSettingsOpen(false)
              props.onAudio(index)
            }}
            onPrefs={(prefs) => {
              props.onPrefs(prefs)
              void updatePlaybackPrefs(prefs).catch(() => {})
            }}
            onClose={() => setSettingsOpen(false)}
          />
        )}
      </AnimatePresence>

      <AnimatePresence>
        {tvOpen && (
          <TvPicker
            onPick={(renderer) => {
              setTvOpen(false)
              store.pause()
              props.onPlayOnTv(renderer, positionRef.current, props.audioTrack)
            }}
            onClose={() => setTvOpen(false)}
          />
        )}
      </AnimatePresence>

      <AnimatePresence>
        {ended && props.next && (
          <UpNext
            label={props.next.label}
            automatic={props.prefs.autoplayNext}
            askStillWatching={props.prefs.stillWatchingAfter > 0 && props.autoplayed >= props.prefs.stillWatchingAfter}
            onPlay={(automatic) => props.onPlayNext(automatic)}
            onReplay={() => void store.seek(0).then(() => store.play())}
            onExit={props.onExit}
          />
        )}
      </AnimatePresence>
    </>
  )
}

/** Closes an overlay panel on Escape before the key reaches the player's shortcuts. */
function useEscape(onClose: () => void): void {
  React.useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.stopPropagation()
        onClose()
      }
    }
    window.addEventListener("keydown", onKey, true)
    return () => window.removeEventListener("keydown", onKey, true)
  }, [onClose])
}

interface SettingsPanelProps {
  session: PlaybackSessionRecord
  quality: number | null
  prefs: PlaybackPrefs
  onQuality: (value: number | null) => void
  onAudio: (index: number) => void
  onPrefs: (prefs: PlaybackPrefs) => void
  onClose: () => void
}

/** Quality, audio track and autoplay, with a line on how the file is being sent. */
function SettingsPanel({ session, quality, prefs, onQuality, onAudio, onPrefs, onClose }: SettingsPanelProps) {
  useEscape(onClose)

  return (
    <motion.div
      role="dialog"
      aria-label="Playback settings"
      initial={{ opacity: 0, y: -6, scale: 0.98 }}
      animate={{ opacity: 1, y: 0, scale: 1 }}
      exit={{ opacity: 0, y: -6, scale: 0.98 }}
      transition={FADE}
      className={PANEL_CLASS}
    >
      <PanelGroup label="Quality">
        {QUALITIES.map((option) => (
          <PanelOption key={option.label} selected={quality === option.value} onClick={() => onQuality(option.value)}>
            {option.label}
          </PanelOption>
        ))}
      </PanelGroup>

      {session.audioTracks.length > 1 && (
        <PanelGroup label="Audio">
          {session.audioTracks.map((track) => (
            <PanelOption key={track.index} selected={session.audioTrack === track.index} onClick={() => onAudio(track.index)}>
              <span className="truncate">{track.title ?? languageName(track.language)}</span>
              <span className="ml-auto shrink-0 pl-3 font-mono text-micro uppercase text-surface/55">
                {track.codec} {track.channels > 2 ? `${track.channels - 1}.1` : track.channels === 1 ? "mono" : "stereo"}
              </span>
            </PanelOption>
          ))}
        </PanelGroup>
      )}

      <label className="flex items-center justify-between gap-3 rounded-[0.75rem] px-3 py-2.5 text-[0.875rem]">
        Play next episode automatically
        <Switch checked={prefs.autoplayNext} onChange={(autoplayNext) => onPrefs({ ...prefs, autoplayNext })} />
      </label>

      <p className="border-t border-surface/10 px-3 pb-1.5 pt-2.5 text-micro leading-relaxed text-surface/60">{describeMode(session)}</p>
    </motion.div>
  )
}

/** Where the TV picker and settings panel sit, under the top bar's buttons. */
const PANEL_CLASS =
  "absolute right-4 top-16 w-[min(20rem,calc(100vw-2rem))] origin-top-right overflow-hidden rounded-panel bg-[oklch(0.2_0.012_265/0.92)] p-2 text-surface shadow-float backdrop-blur-xl md:right-6"

interface TvPickerProps {
  onPick: (renderer: RendererRecord) => void
  onClose: () => void
}

/**
 * DLNA TVs on the network, searched for when the picker opens. Cast and
 * AirPlay devices aren't listed here: the browser finds those, through the
 * buttons in the control bar.
 */
function TvPicker({ onPick, onClose }: TvPickerProps) {
  useEscape(onClose)
  const { renderers, error, searching, search } = useRenderers()

  return (
    <motion.div
      role="dialog"
      aria-label="Play on a TV"
      initial={{ opacity: 0, y: -6, scale: 0.98 }}
      animate={{ opacity: 1, y: 0, scale: 1 }}
      exit={{ opacity: 0, y: -6, scale: 0.98 }}
      transition={FADE}
      className={PANEL_CLASS}
    >
      <div className="flex items-center justify-between px-3 pb-1 pt-2">
        <p className="text-micro font-semibold text-surface/55">TVs on your network</p>
        <button
          type="button"
          onClick={() => void search(true)}
          disabled={searching}
          className="rounded-full px-2 py-1 text-micro font-semibold text-surface/70 transition-colors hover:bg-surface/10 hover:text-surface disabled:opacity-50"
        >
          {searching ? "Searching" : "Search again"}
        </button>
      </div>

      {renderers === null || (searching && renderers.length === 0) ? (
        <div className="flex items-center gap-3 px-3 py-4 text-[0.875rem] text-surface/70">
          <Spinner className="size-4 text-signal" />
          Looking for TVs
        </div>
      ) : renderers.length === 0 ? (
        <p className="px-3 py-3 text-[0.875rem] leading-relaxed text-surface/70">
          No TVs answered. A TV must be on, with DLNA or screen sharing turned on, and on the same network as the Findr server.
        </p>
      ) : (
        <div role="list">
          {renderers.map((renderer) => (
            <button
              key={renderer.id}
              type="button"
              role="listitem"
              onClick={() => onPick(renderer)}
              className="flex w-full items-center gap-3 rounded-[0.75rem] px-3 py-2.5 text-left transition-colors hover:bg-surface/10"
            >
              <TelevisionSimpleIcon aria-hidden weight="duotone" className="size-5 shrink-0 text-signal" />
              <span className="min-w-0 flex-1">
                <span className="block truncate text-[0.875rem] font-medium">{renderer.name}</span>
                {(renderer.manufacturer || renderer.model) && (
                  <span className="block truncate text-micro text-surface/55">{[renderer.manufacturer, renderer.model].filter(Boolean).join(" ")}</span>
                )}
              </span>
            </button>
          ))}
        </div>
      )}

      {error && <p className="px-3 pb-2 text-micro text-[oklch(0.75_0.15_25)]">{error}</p>}
      <p className="border-t border-surface/10 px-3 pb-1.5 pt-2.5 text-micro leading-relaxed text-surface/60">
        For Chromecast or AirPlay, use the cast buttons in the control bar.
      </p>
    </motion.div>
  )
}

function PanelGroup({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div role="radiogroup" aria-label={label} className="mb-1 border-b border-surface/10 pb-1">
      <p className="px-3 pb-1 pt-2 text-micro font-semibold text-surface/55">{label}</p>
      {children}
    </div>
  )
}

function PanelOption({ selected, onClick, children }: { selected: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      type="button"
      role="radio"
      aria-checked={selected}
      onClick={onClick}
      className="flex w-full items-center gap-2 rounded-[0.75rem] px-3 py-2 text-left text-[0.875rem] transition-colors hover:bg-surface/10"
    >
      <CheckIcon aria-hidden weight="bold" className={cn("size-4 shrink-0 text-signal", !selected && "invisible")} />
      {children}
    </button>
  )
}

/** A language's name in the browser's language, from its ISO 639-2 code. */
function languageName(code: string | null): string {
  if (!code) return "Unknown language"
  try {
    return new Intl.DisplayNames([navigator.language], { type: "language" }).of(code) ?? code
  } catch {
    return code
  }
}

interface UpNextProps {
  label: string
  /** Whether to count down and start on its own. */
  automatic: boolean
  /** Ask before carrying on, after enough episodes in a row. */
  askStillWatching: boolean
  onPlay: (automatic: boolean) => void
  onReplay: () => void
  onExit: () => void
}

/** Offered when an episode ends: the next one, counting down unless asked to wait. */
function UpNext({ label, automatic, askStillWatching, onPlay, onReplay, onExit }: UpNextProps) {
  const counting = automatic && !askStillWatching
  const [left, setLeft] = React.useState(COUNTDOWN_SECONDS)

  React.useEffect(() => {
    if (!counting) return
    if (left <= 0) {
      onPlay(true)
      return
    }
    const timer = setTimeout(() => setLeft((current) => current - 1), 1000)
    return () => clearTimeout(timer)
  }, [counting, left, onPlay])

  return (
    <motion.div
      initial={{ opacity: 0, y: 12 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, y: 12 }}
      transition={FADE}
      className="absolute bottom-24 right-4 w-[min(22rem,calc(100vw-2rem))] rounded-panel bg-[oklch(0.2_0.012_265/0.94)] p-5 text-surface shadow-float backdrop-blur-xl md:right-6"
    >
      {askStillWatching ? (
        <>
          <p className="heading text-xl">Still watching?</p>
          <p className="mt-1 text-[0.875rem] text-surface/70">Next is {label}.</p>
          <div className="mt-4 flex gap-2">
            <Button variant="signal" icon={PlayIcon} onClick={() => onPlay(false)}>
              Keep watching
            </Button>
            <Button variant="ghost" className="text-surface/80 hover:bg-surface/10 hover:text-surface" onClick={onExit}>
              Stop
            </Button>
          </div>
        </>
      ) : (
        <>
          <p className="text-micro font-semibold text-surface/55">Up next</p>
          <p className="heading mt-0.5 text-xl">{label}</p>
          <div className="mt-4 flex gap-2">
            <Button variant="signal" icon={PlayIcon} onClick={() => onPlay(false)}>
              {counting ? `Play in ${left}` : "Play"}
            </Button>
            <Button variant="ghost" className="text-surface/80 hover:bg-surface/10 hover:text-surface" onClick={onReplay}>
              Watch again
            </Button>
          </div>
        </>
      )}
    </motion.div>
  )
}

interface PlayerMessageProps {
  title: string
  description: string
  action?: React.ReactNode
  onExit: () => void
}

/** A full-screen message in place of the video, such as a failure to start. */
export function PlayerMessage({ title, description, action, onExit }: PlayerMessageProps) {
  return (
    <div className="flex size-full items-center justify-center px-6">
      <div className="max-w-sm text-center">
        <WarningCircleIcon aria-hidden weight="duotone" className="mx-auto size-10 text-signal" />
        <p className="heading mt-4 text-2xl">{title}</p>
        <p className="mt-2 text-[0.9375rem] leading-relaxed text-surface/70">{description}</p>
        <div className="mt-6 flex justify-center gap-2">
          {action}
          <Button variant="ghost" icon={XIcon} className="text-surface/80 hover:bg-surface/10 hover:text-surface" onClick={onExit}>
            Close
          </Button>
        </div>
      </div>
    </div>
  )
}
