import * as React from "react"
import { AnimatePresence, motion } from "motion/react"
import { ArrowLeftIcon, GearSixIcon, PlayIcon, TelevisionSimpleIcon, WarningCircleIcon, XIcon } from "@phosphor-icons/react"
import { Container, Hotkey } from "@videojs/react"
import { GoogleCast } from "@videojs/react/extensions/google-cast"
import { HlsJsVideo } from "@videojs/react/media/hlsjs-video"
import { VideoPlayer, VideoSkin, usePlayer } from "@videojs/react/video"
import "@videojs/react/video/skin.css"
import type { PlaybackItemKey, PlaybackPrefs, PlaybackSessionRecord, RendererRecord } from "@findr/types/playback"
import { createCastUrl, createPlaybackSession, endPlaybackSession, reportPlaybackProgress, updatePlaybackPrefs } from "@/lib/api"
import { deviceProfile } from "@/lib/device-profile"
import { googleCastConnected, loadOnGoogleCast } from "@/lib/google-cast"
import { FADE } from "@/lib/motion"
import { audioTrackDetail, audioTrackLabel, usePlayback } from "@/lib/playback"
import { rendererDetail, useRenderers } from "@/lib/renderers"
import { cn } from "@/lib/utils"
import { Button } from "@/components/ui/button"
import { Spinner } from "@/components/ui/spinner"
import { Switch } from "@/components/ui/switch"
import { Notice, Panel, PanelDetail, PanelGroup, PanelOption } from "@/components/playback/player-panel"

/**
 * The video player for one movie or episode. It starts a session on the
 * server, plays its HLS stream with Video.js, reports progress as it goes,
 * and offers the next episode when one ends. Changing quality or audio starts
 * a fresh session at the same moment, since the server packages one stream
 * per session, and swaps it into the same video element once it is ready,
 * so playback carries on (on AirPlay too) rather than starting over.
 *
 * Casting: the skin's Cast button sends a TV its own session through the
 * Google Cast extension, Safari's AirPlay button hands over the stream
 * itself (so Safari plays HLS natively there), and the TV button in the top
 * bar lists DLNA renderers, which Findr then drives from the server. While a
 * Google Cast receiver plays, a new audio track or quality is loaded on the
 * receiver directly and the browser's own stream catches up once casting ends.
 *
 * Keyboard: the skin's shortcuts (Space or K, M, F, I, the arrows, J and L,
 * 0 to 9, Home and End, < and >) work anywhere on the page, not only once the
 * player has focus.
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

/** What the viewer picked: a quality cap and an audio track, either null to let the server decide. */
interface Choice {
  quality: number | null
  audioTrack: number | null
}

/** A running session and the choice it was made with. */
interface Stream {
  session: PlaybackSessionRecord
  choice: Choice
  /** Whether it replaced a paused stream, and so waits to be played rather than autoplaying. */
  paused: boolean
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

function sameChoice(a: Choice, b: Choice): boolean {
  return a.quality === b.quality && a.audioTrack === b.audioTrack
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
  const { item } = props
  const { casting } = usePlayback()
  const [choice, setChoice] = React.useState<Choice>(() => ({ quality: readQuality(), audioTrack: null }))
  const [stream, setStream] = React.useState<Stream | null>(null)
  const [error, setError] = React.useState<string | null>(null)
  const [notice, setNotice] = React.useState<string | null>(null)
  const clearNotice = React.useCallback(() => setNotice(null), [])

  // The position to restart from when quality or audio changes, kept current by the player
  const positionRef = React.useRef(props.startMs)
  // The stream playing, and a count that lets only the latest request replace it
  const streamRef = React.useRef<Stream | null>(null)
  const requestRef = React.useRef(0)

  /**
   * Starts a session for `next` where the viewer is and swaps it in, ending
   * the one it replaces, paused if what it replaces was. A switch that fails
   * leaves the old stream playing.
   */
  const start = React.useCallback(
    async (next: Choice, paused = false) => {
      const request = ++requestRef.current
      setError(null)
      try {
        const session = await createPlaybackSession({
          ...item,
          deviceProfile: deviceProfile(),
          maxBitrate: next.quality,
          audioTrack: next.audioTrack,
          startMs: positionRef.current,
        })
        // Superseded, or the player closed, while it started
        if (request !== requestRef.current) {
          void endPlaybackSession(session.id).catch(() => {})
          return
        }
        const previous = streamRef.current
        streamRef.current = { session, choice: next, paused }
        setStream(streamRef.current)
        if (previous) void endPlaybackSession(previous.session.id).catch(() => {})
      } catch (reason) {
        if (request !== requestRef.current) return
        const message = reason instanceof Error ? reason.message : "Playback could not start."
        const current = streamRef.current
        if (current) {
          setChoice(current.choice)
          setNotice(message)
        } else setError(message)
      }
    },
    [item],
  )

  // The first session; leaving ends whatever plays and abandons anything still starting
  const initial = React.useRef(choice)
  React.useEffect(() => {
    void start(initial.current)
    return () => {
      requestRef.current++
      if (streamRef.current) void endPlaybackSession(streamRef.current.session.id).catch(() => {})
      streamRef.current = null
    }
  }, [start])

  /**
   * Applies a new choice: on the Google Cast receiver when one is playing,
   * else to the browser's stream.
   */
  const choose = React.useCallback(
    async (next: Choice, paused: boolean) => {
      const previous = choice
      setChoice(next)
      if (!googleCastConnected()) {
        void start(next, paused)
        return
      }
      try {
        const { url } = await createCastUrl({ ...item, audioTrack: next.audioTrack, maxBitrate: next.quality })
        await loadOnGoogleCast(url, { startSeconds: positionRef.current / 1000, autoplay: !paused, poster: props.posterUrl })
      } catch (reason) {
        setChoice(previous)
        setNotice(reason instanceof Error && reason.message !== "Nothing is casting." ? reason.message : "The TV didn't switch.")
      }
    },
    [choice, item, start, props.posterUrl],
  )

  // Once casting ends, the browser's stream takes up whatever was chosen meanwhile
  const onRemoteEnded = React.useCallback(() => {
    const current = streamRef.current
    if (current && !sameChoice(current.choice, choice)) void start(choice)
  }, [choice, start])

  function chooseQuality(value: number | null, paused: boolean) {
    try {
      if (value === null) localStorage.removeItem(QUALITY_KEY)
      else localStorage.setItem(QUALITY_KEY, String(value))
    } catch {
      // Remembering is a convenience only
    }
    void choose({ ...choice, quality: value }, paused)
  }

  function chooseAudio(index: number, paused: boolean) {
    void choose({ ...choice, audioTrack: index }, paused)
    // Remember the language for everything else this user plays
    const language = stream?.session.audioTracks[index]?.language
    if (language && language !== props.prefs.audioLanguage) {
      const prefs = { ...props.prefs, audioLanguage: language }
      props.onPrefs(prefs)
      void updatePlaybackPrefs(prefs).catch(() => {})
    }
  }

  const session = stream?.session ?? null

  return (
    <div className="fixed inset-0 bg-[oklch(0.13_0.01_265)] text-surface">
      {error ? (
        <PlayerMessage
          title="This can't play right now"
          description={error}
          onExit={props.onExit}
          action={
            <Button variant="signal" onClick={() => void start(choice)}>
              Try again
            </Button>
          }
        />
      ) : !session ? (
        <div className="flex size-full items-center justify-center">
          <Spinner className="size-8 text-signal" />
        </div>
      ) : (
        <VideoPlayer>
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
                autoPlay={!stream?.paused}
                playsInline
                poster={props.posterUrl ?? undefined}
              >
                {session.trickplayUrl && <track kind="metadata" label="thumbnails" src={session.trickplayUrl} default />}
              </HlsJsVideo>
            </VideoSkin>
            {casting && session.castUrl && <GoogleCast src={session.castUrl} contentType={HLS_TYPE} streamType="on-demand" />}
            <PageHotkeys />
            <Session
              {...props}
              casting={casting}
              choice={choice}
              session={session}
              positionRef={positionRef}
              onQuality={chooseQuality}
              onAudio={chooseAudio}
              onRemoteEnded={onRemoteEnded}
              onLost={() => void start(stream?.choice ?? choice)}
            />
            <Notice message={notice} onDone={clearNotice} />
          </Container>
        </VideoPlayer>
      )}
    </div>
  )
}

/* -------------------------------------------------------------------------- */
/* Inside the player                                                          */
/* -------------------------------------------------------------------------- */

/**
 * The skin's shortcuts again, listening on the whole page. The skin binds
 * them to the player alone, so they would do nothing until the player is
 * clicked, or once a panel's button that had focus goes away. While focus is
 * in the player its own binding acts first and these stand aside.
 */
function PageHotkeys() {
  return (
    <>
      <Hotkey target="document" keys="Space" action="togglePaused" />
      <Hotkey target="document" keys="k" action="togglePaused" />
      <Hotkey target="document" keys="m" action="toggleMuted" />
      <Hotkey target="document" keys="f" action="toggleFullscreen" />
      <Hotkey target="document" keys="i" action="togglePictureInPicture" />
      <Hotkey target="document" keys="ArrowRight" action="seekStep" />
      <Hotkey target="document" keys="ArrowLeft" action="seekStep" />
      <Hotkey target="document" keys="l" action="seekStep" />
      <Hotkey target="document" keys="j" action="seekStep" />
      <Hotkey target="document" keys="ArrowUp" action="volumeStep" />
      <Hotkey target="document" keys="ArrowDown" action="volumeStep" />
      <Hotkey target="document" keys="0-9" action="seekToPercent" />
      <Hotkey target="document" keys="Home" action="seekToPercent" value={0} />
      <Hotkey target="document" keys="End" action="seekToPercent" value={100} />
      <Hotkey target="document" keys=">" action="speedUp" />
      <Hotkey target="document" keys="<" action="speedDown" />
    </>
  )
}

interface SessionProps extends PlayerProps {
  casting: boolean
  choice: Choice
  session: PlaybackSessionRecord
  positionRef: React.RefObject<number>
  /** Picks a quality; `paused` says whether what plays is paused, so a TV switched to it stays so. */
  onQuality: (value: number | null, paused: boolean) => void
  onAudio: (index: number, paused: boolean) => void
  /** Casting or AirPlay ended. */
  onRemoteEnded: () => void
  /** The stream failed; start a fresh session where it stopped. */
  onLost: () => void
}

/** Everything drawn over the video: the top bar, settings, and the next-episode offer. */
function Session(props: SessionProps) {
  const { session, item, positionRef, onRemoteEnded } = props
  const store = usePlayer()
  const currentTime = usePlayer((state) => state.currentTime)
  const paused = usePlayer((state) => state.paused)
  const ended = usePlayer((state) => state.ended)
  const controlsVisible = usePlayer((state) => state.controlsVisible)
  const mediaError = usePlayer((state) => state.error)
  const remote = usePlayer((state) => state.remotePlaybackState)
  const [settingsOpen, setSettingsOpen] = React.useState(false)
  const [tvOpen, setTvOpen] = React.useState(false)

  // Keep the restart point current
  React.useEffect(() => {
    if (currentTime > 0) positionRef.current = Math.round(currentTime * 1000)
  }, [currentTime, positionRef])

  // A stream that fails mid-way, such as one reaped while the tab slept, restarts where it was, once per stream
  const lostOnce = React.useRef<string | null>(null)
  React.useEffect(() => {
    if (!mediaError || lostOnce.current === session.id) return
    lostOnce.current = session.id
    props.onLost()
  }, [mediaError, session.id, props])

  // Casting ending hands playback back to this browser
  const wasRemote = React.useRef(remote)
  React.useEffect(() => {
    if (wasRemote.current === "connected" && remote === "disconnected") onRemoteEnded()
    wasRemote.current = remote
  }, [remote, onRemoteEnded])

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
  const closeSettings = React.useCallback(() => setSettingsOpen(false), [])
  const closeTv = React.useCallback(() => setTvOpen(false), [])

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
            choice={props.choice}
            prefs={props.prefs}
            onQuality={(value) => {
              setSettingsOpen(false)
              props.onQuality(value, paused)
            }}
            onAudio={(index) => {
              setSettingsOpen(false)
              props.onAudio(index, paused)
            }}
            onPrefs={(prefs) => {
              props.onPrefs(prefs)
              void updatePlaybackPrefs(prefs).catch(() => {})
            }}
            onClose={closeSettings}
          />
        )}
      </AnimatePresence>

      <AnimatePresence>
        {tvOpen && (
          <TvPicker
            onPick={(renderer) => {
              setTvOpen(false)
              store.pause()
              props.onPlayOnTv(renderer, positionRef.current, props.choice.audioTrack ?? session.audioTrack)
            }}
            onClose={closeTv}
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

interface SettingsPanelProps {
  session: PlaybackSessionRecord
  choice: Choice
  prefs: PlaybackPrefs
  onQuality: (value: number | null) => void
  onAudio: (index: number) => void
  onPrefs: (prefs: PlaybackPrefs) => void
  onClose: () => void
}

/** Quality, audio track and autoplay, with a line on how the file is being sent. */
function SettingsPanel({ session, choice, prefs, onQuality, onAudio, onPrefs, onClose }: SettingsPanelProps) {
  // The track picked, else the one the server chose for this session
  const audioTrack = choice.audioTrack ?? session.audioTrack

  return (
    <Panel label="Playback settings" onClose={onClose}>
      <PanelGroup label="Quality">
        {QUALITIES.map((option) => (
          <PanelOption key={option.label} selected={choice.quality === option.value} onClick={() => onQuality(option.value)}>
            {option.label}
          </PanelOption>
        ))}
      </PanelGroup>

      {session.audioTracks.length > 1 && (
        <PanelGroup label="Audio">
          {session.audioTracks.map((track) => (
            <PanelOption key={track.index} selected={audioTrack === track.index} onClick={() => onAudio(track.index)}>
              <span className="truncate">{audioTrackLabel(track, session.audioTracks)}</span>
              <PanelDetail>{audioTrackDetail(track)}</PanelDetail>
            </PanelOption>
          ))}
        </PanelGroup>
      )}

      <label className="flex items-center justify-between gap-3 rounded-[0.75rem] px-3 py-2.5 text-[0.875rem]">
        Play next episode automatically
        <Switch checked={prefs.autoplayNext} onChange={(autoplayNext) => onPrefs({ ...prefs, autoplayNext })} />
      </label>

      <p className="border-t border-surface/10 px-3 pb-1.5 pt-2.5 text-micro leading-relaxed text-surface/60">{describeMode(session)}</p>
    </Panel>
  )
}

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
  const { renderers, error, searching, search } = useRenderers()

  return (
    <Panel label="Play on a TV" onClose={onClose}>
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
                {rendererDetail(renderer) && <span className="block truncate text-micro text-surface/55">{rendererDetail(renderer)}</span>}
              </span>
            </button>
          ))}
        </div>
      )}

      {error && <p className="px-3 pb-2 text-micro text-[oklch(0.75_0.15_25)]">{error}</p>}
      <p className="border-t border-surface/10 px-3 pb-1.5 pt-2.5 text-micro leading-relaxed text-surface/60">
        For Chromecast or AirPlay, use the cast buttons in the control bar.
      </p>
    </Panel>
  )
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
