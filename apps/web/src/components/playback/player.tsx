import * as React from "react"
import { AnimatePresence, motion } from "motion/react"
import { ArrowLeftIcon, ArrowsClockwiseIcon, SkipForwardIcon, TelevisionSimpleIcon, WarningCircleIcon, XIcon } from "@phosphor-icons/react"
import { Container, Hotkey } from "@videojs/react"
import { GoogleCast } from "@videojs/react/extensions/google-cast"
import { AirPlayEnterIcon, CastEnterIcon, CastExitIcon, SpeechIcon, SwitchesIcon } from "@videojs/react/icons"
import { HlsJsVideo } from "@videojs/react/media/hlsjs-video"
import { VideoPlayer, usePlayer } from "@videojs/react/video"
import type { PlaybackItemKey, PlaybackPrefs, PlaybackSessionRecord, RendererRecord } from "@findr/types/playback"
import { ApiError, createCastUrl, createPlaybackSession, endPlaybackSession, fetchCredits, reportPlaybackProgress, updatePlaybackPrefs } from "@/lib/api"
import { deviceProfile } from "@/lib/device-profile"
import { googleCastConnected, loadOnGoogleCast } from "@/lib/google-cast"
import { FADE } from "@/lib/motion"
import { audioTrackDetail, audioTrackLabel, usePlayback } from "@/lib/playback"
import { rendererDetail, useRenderers } from "@/lib/renderers"
import { cn } from "@/lib/utils"
import { Button } from "@/components/ui/button"
import { Spinner } from "@/components/ui/spinner"
import { NextEpisodeButton } from "@/components/playback/next-episode-button"
import { BarMenu, CheckItem, MenuLabel, MenuNote, MenuRow, Submenu } from "@/components/playback/player-menu"
import { Notice } from "@/components/playback/player-panel"
import { CaptionsSubmenu } from "@/components/videojs/ui/captions-submenu"
import { PlaybackRateSubmenu } from "@/components/videojs/ui/playback-rate-submenu"
import { VideoSkin } from "@/components/videojs/video/skin"

/**
 * The video player for one movie or episode. It starts a session on the
 * server, plays its HLS stream with Video.js, reports progress as it goes,
 * and offers the next episode when one ends. Changing quality or audio starts
 * a fresh session at the same moment, since the server packages one stream
 * per session, and swaps it into the same video element once it is ready,
 * so playback carries on (on AirPlay too) rather than starting over.
 *
 * Next episode: once the credits start (where the server says they do), a
 * Next Episode button counts down and moves on. Pausing holds it; seeking
 * within the credits or pressing Escape stops it, leaving the button. Credits
 * that can't be found leave only the button at the end.
 *
 * The skin is Video.js's default video skin, installed as source under
 * `components/videojs/` so Findr can fill its settings menu (quality and
 * audio here mean a new session, so they are Findr's own submenus beside the
 * skin's speed and captions) and add a TV button to its control bar.
 *
 * Casting: the skin's Cast button sends a TV its own session through the
 * Google Cast extension, Safari's AirPlay button hands over the stream
 * itself (so Safari plays HLS natively there), and the TV button beside them
 * lists DLNA renderers, which Findr then drives from the server. While a
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
  /** The next episode on disk, offered when the credits start and when this one ends. */
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

/** Whether this is a Chromium browser, the only kind that offers Google Cast (the skin's own test). */
const GOOGLE_CAST = typeof window !== "undefined" && "chrome" in window

/** Whether the page was opened on this machine, so a relative URL would mean nothing to a TV. */
function openedLocally(): boolean {
  return ["localhost", "127.0.0.1", "[::1]"].includes(window.location.hostname)
}

/** Quality caps offered by hand, in bits per second; null sends the file as good as the device takes. */
const QUALITIES: { value: number | null; label: string }[] = [
  { value: null, label: "Best" },
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

/** A jump in position bigger than this is a seek, not playback. */
const SEEK_JUMP_SECONDS = 3

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
              settings={
                <SettingsItems
                  session={session}
                  choice={choice}
                  prefs={props.prefs}
                  onQuality={chooseQuality}
                  onAudio={chooseAudio}
                  onPrefs={(prefs) => {
                    props.onPrefs(prefs)
                    void updatePlaybackPrefs(prefs).catch(() => {})
                  }}
                />
              }
              cast={
                casting && (
                  <CastMenu onPick={(renderer) => props.onPlayOnTv(renderer, positionRef.current, choice.audioTrack ?? session.audioTrack)} />
                )
              }
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
              session={session}
              positionRef={positionRef}
              onRemoteEnded={onRemoteEnded}
              onLost={(paused) => void start(stream?.choice ?? choice, paused)}
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
  session: PlaybackSessionRecord
  positionRef: React.RefObject<number>
  /** Casting or AirPlay ended. */
  onRemoteEnded: () => void
  /** The stream failed or its session is gone; start a fresh session where it stopped, paused if it was. */
  onLost: (paused: boolean) => void
}

/** What goes on alongside the video: progress reports, recovery, the top bar, and the next-episode offer. */
function Session(props: SessionProps) {
  const { session, item, positionRef, onRemoteEnded } = props
  const store = usePlayer()
  const currentTime = usePlayer((state) => state.currentTime)
  const paused = usePlayer((state) => state.paused)
  const ended = usePlayer((state) => state.ended)
  const controlsVisible = usePlayer((state) => state.controlsVisible)
  const mediaError = usePlayer((state) => state.error)
  const remote = usePlayer((state) => state.remotePlaybackState)

  // Keep the restart point current
  React.useEffect(() => {
    if (currentTime > 0) positionRef.current = Math.round(currentTime * 1000)
  }, [currentTime, positionRef])

  // A stream that fails mid-way, or whose session was reaped while the tab slept, restarts where it was, once
  // per stream. Safari's native player never reports the reaped session's missing segments, so the server's
  // answer to a progress report is the signal there.
  const lostOnce = React.useRef<string | null>(null)
  const [reaped, setReaped] = React.useState<string | null>(null)
  React.useEffect(() => {
    if ((!mediaError && reaped !== session.id) || lostOnce.current === session.id) return
    lostOnce.current = session.id
    props.onLost(paused && !mediaError)
  }, [mediaError, reaped, paused, session.id, props])

  // Casting ending hands playback back to this browser
  const wasRemote = React.useRef(remote)
  React.useEffect(() => {
    if (wasRemote.current === "connected" && remote === "disconnected") onRemoteEnded()
    wasRemote.current = remote
  }, [remote, onRemoteEnded])

  // Report the position on a steady beat, and on pause; the last report ends the session
  const report = React.useCallback(
    (event: "tick" | "pause" | "seek" | "stop", keepalive = false) => {
      void reportPlaybackProgress({ ...item, sessionId: session.id, positionMs: positionRef.current, event }, keepalive).catch((reason) => {
        if (reason instanceof ApiError && reason.code === "session_not_found") setReaped(session.id)
      })
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
  // Resuming reports too, so a session reaped during a long pause is found out at once
  React.useEffect(() => {
    if (positionRef.current > 0) report(paused ? "pause" : "tick")
  }, [paused, report, positionRef])
  // Reaching the end marks it watched but keeps the session, so playing it again still works
  React.useEffect(() => {
    if (ended) {
      positionRef.current = session.durationMs
      report("tick")
    }
  }, [ended, report, positionRef, session.durationMs])

  // The credits, where Next Episode shows and counts down; seeking back before them resets it
  const creditsMs = useCredits(item, props.next !== null)
  const inCredits = creditsMs !== null && !ended && currentTime * 1000 >= creditsMs
  const offerNext = props.next !== null && (inCredits || ended)
  const [stayed, setStayed] = React.useState(false)
  React.useEffect(() => {
    if (!inCredits && !ended) setStayed(false)
  }, [inCredits, ended])

  // Seeking within the credits, or Escape, means staying for them: the countdown stops, the button stays
  const lastTime = React.useRef(currentTime)
  React.useEffect(() => {
    const fromCredits = creditsMs !== null && lastTime.current * 1000 >= creditsMs
    if (inCredits && fromCredits && Math.abs(currentTime - lastTime.current) > SEEK_JUMP_SECONDS) setStayed(true)
    lastTime.current = currentTime
  }, [currentTime, inCredits, creditsMs])
  React.useEffect(() => {
    if (!offerNext || stayed) return
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setStayed(true)
    }
    document.addEventListener("keydown", onKey)
    return () => document.removeEventListener("keydown", onKey)
  }, [offerNext, stayed])

  // Moving on counts this episode as watched to the end, whatever of the credits played
  const { onPlayNext } = props
  const playNext = React.useCallback(
    (automatic: boolean) => {
      positionRef.current = session.durationMs
      report("stop", true)
      onPlayNext(automatic)
    },
    [onPlayNext, positionRef, report, session.durationMs],
  )

  const chromeVisible = controlsVisible || paused
  const askStillWatching = props.prefs.stillWatchingAfter > 0 && props.autoplayed >= props.prefs.stillWatchingAfter

  return (
    <>
      {/* Top bar: back and what is playing */}
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
      </motion.div>

      {/* One button through the credits and the end, so its countdown carries on across both */}
      <AnimatePresence>
        {offerNext && props.next && (
          <NextEpisodeButton
            key="next"
            code={props.next.label}
            onClick={() => playNext(false)}
            countdown={props.prefs.autoplayNext && !askStillWatching && !stayed ? { held: paused && !ended, onDone: () => playNext(true) } : undefined}
            className="absolute bottom-24 right-4 md:right-6"
          />
        )}
      </AnimatePresence>
    </>
  )
}

interface SettingsItemsProps {
  session: PlaybackSessionRecord
  choice: Choice
  prefs: PlaybackPrefs
  /** Picks a quality; `paused` says whether what plays is paused, so a TV switched to it stays so. */
  onQuality: (value: number | null, paused: boolean) => void
  onAudio: (index: number, paused: boolean) => void
  onPrefs: (prefs: PlaybackPrefs) => void
}

/**
 * The settings menu: quality and audio track (Findr's, as each means a new
 * session), the skin's speed and captions, autoplay, and a line on how the
 * file is being sent.
 */
function SettingsItems({ session, choice, prefs, onQuality, onAudio, onPrefs }: SettingsItemsProps) {
  const paused = usePlayer((state) => state.paused)
  // The track picked, else the one the server chose for this session
  const audioTrack = choice.audioTrack ?? session.audioTrack

  return (
    <>
      <Submenu
        icon={SwitchesIcon}
        label="Quality"
        options={QUALITIES.map((option) => ({ value: String(option.value), label: option.label }))}
        value={String(choice.quality)}
        onValueChange={(value) => onQuality(QUALITIES.find((option) => String(option.value) === value)?.value ?? null, paused)}
      />
      {session.audioTracks.length > 1 && (
        <Submenu
          icon={SpeechIcon}
          label="Audio"
          options={session.audioTracks.map((track) => ({
            value: String(track.index),
            label: audioTrackLabel(track, session.audioTracks),
            detail: audioTrackDetail(track),
          }))}
          value={String(audioTrack)}
          onValueChange={(value) => onAudio(Number(value), paused)}
        />
      )}
      <PlaybackRateSubmenu />
      <CaptionsSubmenu />
      <CheckItem icon={SkipForwardIcon} checked={prefs.autoplayNext} onCheckedChange={(autoplayNext) => onPrefs({ ...prefs, autoplayNext })}>
        Autoplay next episode
      </CheckItem>
      <MenuNote>{describeMode(session)}</MenuNote>
    </>
  )
}

/**
 * The control bar's one cast button, in place of the skin's Cast and AirPlay
 * buttons: Chromecast and AirPlay, where the browser offers them, open the
 * browser's own device picker, and below them the DLNA TVs on the network,
 * searched for each time the menu opens.
 */
function CastMenu({ onPick }: { onPick: (renderer: RendererRecord) => void }) {
  const store = usePlayer()
  const remoteState = usePlayer((state) => state.remotePlaybackState)
  const availability = usePlayer((state) => state.remotePlaybackAvailability)
  const [open, setOpen] = React.useState(false)
  const connected = remoteState === "connected"

  // The browser's picker needs the click that chose the row, so it is asked before the menu closes
  const prompt = () => {
    void store.promptRemotePlayback().catch(() => {})
    setOpen(false)
  }

  return (
    <BarMenu icon={connected ? CastExitIcon : CastEnterIcon} label={connected ? "Casting" : "Cast"} open={open} onOpenChange={setOpen}>
      {GOOGLE_CAST && availability !== "unsupported" && (
        <MenuRow icon={CastEnterIcon} onSelect={prompt} disabled={!connected && availability !== "available"}>
          {connected ? "Stop casting" : availability === "available" ? "Chromecast" : "No Chromecast found"}
        </MenuRow>
      )}
      {AIRPLAY && availability === "available" && (
        <MenuRow icon={AirPlayEnterIcon} onSelect={prompt}>
          {connected ? "Stop AirPlay" : "AirPlay"}
        </MenuRow>
      )}
      {open && (
        <TvList
          onPick={(renderer) => {
            setOpen(false)
            store.pause()
            onPick(renderer)
          }}
        />
      )}
    </BarMenu>
  )
}

/** The TVs themselves, searched for when the list mounts. */
function TvList({ onPick }: { onPick: (renderer: RendererRecord) => void }) {
  const { renderers, error, searching, search } = useRenderers()

  return (
    <>
      <MenuLabel>TVs on your network</MenuLabel>
      {renderers === null || (searching && renderers.length === 0) ? (
        <div className="flex items-center gap-2 px-2 py-1.5">
          <Spinner className="size-media-icon text-signal" />
          Looking for TVs
        </div>
      ) : renderers.length === 0 ? (
        <p className="w-0 min-w-full whitespace-normal px-2 py-1 leading-snug text-media-muted-foreground">
          No TVs answered. A TV must be on, with DLNA or screen sharing turned on, and on the same network as the Findr server.
        </p>
      ) : (
        renderers.map((renderer) => (
          <MenuRow key={renderer.id} icon={TelevisionSimpleIcon} onSelect={() => onPick(renderer)}>
            <span className="min-w-0">
              <span className="block truncate">{renderer.name}</span>
              {rendererDetail(renderer) && <span className="block truncate text-media-sm text-media-muted-foreground">{rendererDetail(renderer)}</span>}
            </span>
          </MenuRow>
        ))
      )}
      <MenuRow icon={ArrowsClockwiseIcon} onSelect={() => void search(true)} disabled={searching}>
        {searching ? "Searching" : "Search again"}
      </MenuRow>
      {error && <p className="px-2 pb-1 text-media-sm text-[oklch(0.75_0.15_25)]">{error}</p>}
    </>
  )
}

/**
 * Where an episode's credits start, asked once it plays when there is a next
 * episode to offer; null while unknown.
 */
function useCredits(item: PlaybackItemKey, wanted: boolean): number | null {
  const [creditsMs, setCreditsMs] = React.useState<number | null>(null)
  const { titleId, season, episode } = item

  React.useEffect(() => {
    setCreditsMs(null)
    if (!wanted || season === null || episode === null) return
    const controller = new AbortController()
    fetchCredits({ titleId, season, episode }, { signal: controller.signal })
      .then((record) => setCreditsMs(record.creditsMs))
      .catch(() => {})
    return () => controller.abort()
  }, [titleId, season, episode, wanted])
  return creditsMs
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
