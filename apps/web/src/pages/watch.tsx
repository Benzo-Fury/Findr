import * as React from "react"
import { useNavigate, useParams, useSearchParams } from "react-router-dom"
import { motion } from "motion/react"
import { ArrowCounterClockwiseIcon, PlayIcon } from "@phosphor-icons/react"
import type { PlayableItem, PlaybackItemKey, PlaybackPrefs, RendererRecord } from "@findr/types/playback"
import { PlaybackPrefsSchema } from "@findr/types/playback"
import { fetchPlaybackPrefs } from "@/lib/api"
import { episodeCode } from "@/lib/format"
import { useLibrary } from "@/lib/library"
import { EASE_OUT } from "@/lib/motion"
import { formatClock, itemKey, resumePosition, usePlayback, watchPath } from "@/lib/playback"
import { tmdbImage } from "@/lib/tmdb-image"
import { Button } from "@/components/ui/button"
import { Spinner } from "@/components/ui/spinner"
import { Player, PlayerMessage } from "@/components/playback/player"
import { TvRemote } from "@/components/playback/tv-remote"

/**
 * Watching one movie or episode, full screen. A saved position is offered
 * as Resume or Start over before anything loads; episodes chain into the
 * next one on disk. Leaving goes back where the viewer came from.
 *
 * With a TV picked to cast to, the page becomes that TV's remote at once,
 * picking up from the saved position without asking, and the next episode
 * opens straight on the remote too. Picking a TV in the player makes it the
 * cast target; "Watch here" clears it. `?tv=<id>` opens the remote of a TV
 * this user already has playing, as the Cast button links to.
 */

/** A DLNA TV playing this, with where and in which language it started. */
interface TvChoice {
  renderer: RendererRecord
  startMs: number
  /** Send it again even if the TV already plays it. */
  restart: boolean
  audioTrack: number | null
}

/** Consecutive episodes started on their own, for the "still watching" check; kept for the tab's life. */
const AUTOPLAY_KEY = "findr:autoplayed"

function readAutoplayed(): number {
  try {
    return Number(sessionStorage.getItem(AUTOPLAY_KEY)) || 0
  } catch {
    return 0
  }
}

function writeAutoplayed(count: number): void {
  try {
    sessionStorage.setItem(AUTOPLAY_KEY, String(count))
  } catch {
    // A convenience only
  }
}

export function WatchPage() {
  const { titleId = "" } = useParams()
  const [params] = useSearchParams()
  const navigate = useNavigate()
  const { entries, loading } = useLibrary()
  const playback = usePlayback()

  const season = params.get("s")
  const episode = params.get("e")
  const key = React.useMemo<PlaybackItemKey>(
    () => ({ titleId, season: season === null ? null : Number(season), episode: episode === null ? null : Number(episode) }),
    [titleId, season, episode],
  )
  const item = playback.itemFor(key)
  const entry = entries.find((candidate) => candidate.title.id === titleId)

  const [prefs, setPrefs] = React.useState<PlaybackPrefs>(() => PlaybackPrefsSchema.parse({}))
  React.useEffect(() => {
    void fetchPlaybackPrefs().then(setPrefs).catch(() => {})
  }, [])

  // Resume is asked once per visit; `?from=0` or a choice settles it
  const [startMs, setStartMs] = React.useState<number | null>(params.get("from") === "0" ? 0 : null)
  React.useEffect(() => setStartMs(params.get("from") === "0" ? 0 : null), [key, params])

  // The TV this plays on, settled from the cast target once per movie or episode
  // (during render, so the browser player never starts first, and only once, so
  // a later progress refresh can't send it to the TV again)
  const id = itemKey(key)
  const [decided, setDecided] = React.useState<{ id: string; tv: TvChoice | null } | null>(null)
  let current = decided
  if (item && decided?.id !== id) {
    const restart = params.get("from") === "0"
    const rejoin = playback.casts.find((cast) => cast.renderer.id === params.get("tv"))?.renderer
    const target = rejoin ?? playback.castTarget
    current = { id, tv: target ? { renderer: target, startMs: restart ? 0 : resumePosition(item), restart, audioTrack: null } : null }
    setDecided(current)
  }
  const tv = current?.id === id ? current.tv : null

  // The next episode on disk after this one
  const next = React.useMemo(() => {
    if (key.season === null) return null
    const episodes = playback.itemsOf(titleId).filter((candidate) => candidate.season !== null && candidate.episode !== null)
    episodes.sort((a, b) => (a.season ?? 0) - (b.season ?? 0) || (a.episode ?? 0) - (b.episode ?? 0))
    const index = episodes.findIndex((candidate) => candidate.season === key.season && candidate.episode === key.episode)
    const following = index >= 0 ? episodes[index + 1] : undefined
    return following ? { key: { titleId, season: following.season, episode: following.episode }, label: episodeCode(following.season ?? 0, following.episode) } : null
  }, [playback, titleId, key.season, key.episode])

  // Leaving refreshes progress for the pages behind
  const exit = React.useCallback(() => {
    playback.refresh()
    if (window.history.length > 1) navigate(-1)
    else navigate("/")
  }, [navigate, playback])

  const playNext = React.useCallback(
    (automatic: boolean) => {
      if (!next) return
      writeAutoplayed(automatic ? readAutoplayed() + 1 : 0)
      navigate(`${watchPath(next.key)}${next.key.season !== null ? "&" : "?"}from=0`, { replace: true })
    },
    [navigate, next],
  )

  const title = entry?.card?.title ?? ""
  const subtitle = key.season !== null && key.episode !== null ? episodeCode(key.season, key.episode) : null
  const backdrop = tmdbImage(entry?.card?.backdropPath, "backdropLarge")

  // Wait for the library and playback state before deciding anything
  if (!playback.ready || loading) {
    return (
      <div className="fixed inset-0 flex items-center justify-center bg-[oklch(0.13_0.01_265)] text-surface">
        <Spinner className="size-8 text-signal" />
      </div>
    )
  }
  if (!playback.enabled) {
    return (
      <div className="fixed inset-0 bg-[oklch(0.13_0.01_265)] text-surface">
        <PlayerMessage title="Playback is off" description="Playback is turned off on this server, or ffmpeg isn't installed." onExit={exit} />
      </div>
    )
  }
  if (!item) {
    return (
      <div className="fixed inset-0 bg-[oklch(0.13_0.01_265)] text-surface">
        <PlayerMessage title="Not ready to play" description="Findr hasn't finished reading this file yet, or it is no longer on disk." onExit={exit} />
      </div>
    )
  }

  // On a TV: this page is its remote
  if (tv) {
    return (
      <TvRemote
        key={`${key.titleId}:${key.season}:${key.episode}`}
        renderer={tv.renderer}
        item={key}
        startMs={tv.startMs}
        restart={tv.restart}
        audioTrack={tv.audioTrack}
        title={title}
        subtitle={subtitle}
        backdrop={backdrop}
        next={next}
        onWatchHere={(positionMs) => {
          playback.setCastTarget(null)
          setDecided({ id, tv: null })
          setStartMs(positionMs)
        }}
        onPlayNext={() => playNext(false)}
        onExit={exit}
      />
    )
  }

  // A saved position: resume or start over
  if (startMs === null && item.positionMs > 0) {
    return <ResumePrompt item={item} title={title} subtitle={subtitle} backdrop={backdrop} onChoose={setStartMs} onExit={exit} />
  }

  return (
    <Player
      key={`${key.titleId}:${key.season}:${key.episode}`}
      item={key}
      startMs={startMs ?? 0}
      title={title}
      subtitle={subtitle}
      posterUrl={backdrop}
      prefs={prefs}
      onPrefs={setPrefs}
      next={next}
      autoplayed={readAutoplayed()}
      onPlayNext={playNext}
      onPlayOnTv={(renderer, positionMs, audioTrack) => {
        playback.setCastTarget(renderer)
        setDecided({ id, tv: { renderer, startMs: positionMs, restart: true, audioTrack } })
      }}
      onExit={exit}
    />
  )
}

interface ResumePromptProps {
  item: PlayableItem
  title: string
  subtitle: string | null
  backdrop: string | null
  onChoose: (startMs: number) => void
  onExit: () => void
}

/** Resume or start over, over the title's artwork. */
function ResumePrompt({ item, title, subtitle, backdrop, onChoose, onExit }: ResumePromptProps) {
  return (
    <div className="fixed inset-0 overflow-hidden bg-[oklch(0.13_0.01_265)] text-surface">
      {backdrop && <img src={backdrop} alt="" className="absolute inset-0 size-full object-cover opacity-35" />}
      <div className="absolute inset-0 bg-gradient-to-t from-[oklch(0.13_0.01_265)] via-[oklch(0.13_0.01_265/0.6)] to-transparent" />
      <motion.div
        initial={{ opacity: 0, y: 12 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.45, ease: EASE_OUT }}
        className="absolute inset-x-0 bottom-0 mx-auto max-w-[1600px] px-6 pb-14 md:px-12 md:pb-20"
      >
        {subtitle && <p className="font-mono text-[0.8125rem] text-surface/70 tabular">{subtitle}</p>}
        <h1 className="display mt-1 max-w-3xl text-4xl md:text-6xl">{title}</h1>
        <div className="mt-6 h-1 w-full max-w-md overflow-hidden rounded-full bg-surface/15">
          <div className="h-full rounded-full bg-signal" style={{ width: `${Math.min(100, (item.positionMs / item.durationMs) * 100)}%` }} />
        </div>
        <div className="mt-6 flex flex-wrap gap-3">
          <Button variant="signal" size="lg" icon={PlayIcon} onClick={() => onChoose(item.positionMs)}>
            Resume from {formatClock(item.positionMs)}
          </Button>
          <Button variant="ghost" size="lg" icon={ArrowCounterClockwiseIcon} className="text-surface/85 hover:bg-surface/10 hover:text-surface" onClick={() => onChoose(0)}>
            Start over
          </Button>
          <Button variant="ghost" size="lg" className="text-surface/60 hover:bg-surface/10 hover:text-surface" onClick={onExit}>
            Back
          </Button>
        </div>
      </motion.div>
    </div>
  )
}
