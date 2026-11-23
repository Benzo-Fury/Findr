import * as React from "react"
import { useNavigate, useParams, useSearchParams } from "react-router-dom"
import type { PlaybackItemKey, PlaybackPrefs, RendererRecord } from "@findr/types/playback"
import { PlaybackPrefsSchema } from "@findr/types/playback"
import { fetchPlaybackPrefs } from "@/lib/api"
import { episodeCode } from "@/lib/format"
import { useLibrary } from "@/lib/library"
import { itemKey, resumePosition, usePlayback, watchPath } from "@/lib/playback"
import { tmdbImage } from "@/lib/tmdb-image"
import { Spinner } from "@/components/ui/spinner"
import { Player, PlayerMessage } from "@/components/playback/player"
import { TvRemote } from "@/components/playback/tv-remote"

/**
 * Watching one movie or episode, full screen. Playback starts at once, from
 * the saved position unless `?from=0` asks for the beginning; episodes chain
 * into the next one on disk. Leaving goes back where the viewer came from.
 *
 * With a TV picked to cast to, the page becomes that TV's remote at once,
 * picking up from the saved position without asking, and the next episode
 * opens straight on the remote too, whether picked there or started on the
 * TV by the server once the credits rolled. Picking a TV in the player makes it the
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

  const id = itemKey(key)

  // Where the browser player starts, settled once per movie or episode (during render, and only
  // once, so a later progress refresh can't restart the stream): the saved position, or the top
  const [start, setStart] = React.useState<{ id: string; ms: number } | null>(null)
  let startMs = start?.id === id ? start.ms : null
  if (item && startMs === null) {
    startMs = params.get("from") === "0" ? 0 : resumePosition(item)
    setStart({ id, ms: startMs })
  }

  // The TV this plays on, settled from the cast target once per movie or episode
  // (during render, so the browser player never starts first, and only once, so
  // a later progress refresh can't send it to the TV again)
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
      navigate(watchPath(next.key, true), { replace: true })
    },
    [navigate, next],
  )

  // A TV that moved on by itself: the next episode's remote rejoins it rather than sending it again
  const followRenderer = tv?.renderer ?? null
  const followNext = React.useCallback(() => {
    if (!next || !followRenderer) return
    playback.setCastTarget(followRenderer)
    navigate(watchPath(next.key), { replace: true })
  }, [navigate, next, followRenderer, playback])

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
          setStart({ id, ms: positionMs })
        }}
        onPlayNext={() => {
          // The next episode stays on this TV, even when the remote was opened through `?tv=`
          playback.setCastTarget(tv.renderer)
          playNext(false)
        }}
        onFollowNext={followNext}
        onExit={exit}
      />
    )
  }

  return (
    // Not keyed by episode: the player swaps the next one into the same video element, keeping fullscreen
    <Player
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
