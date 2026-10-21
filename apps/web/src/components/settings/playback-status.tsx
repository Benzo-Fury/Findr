import * as React from "react"
import {
  CheckCircleIcon,
  CpuIcon,
  MonitorIcon,
  ScreencastIcon,
  StopIcon,
  TelevisionSimpleIcon,
  WarningCircleIcon,
  type Icon,
} from "@phosphor-icons/react"
import type { EncoderTestResult, NowPlayingRecord, PlaybackDevice } from "@findr/types/playback"
import { fetchNowPlaying, stopNowPlaying, testEncoder } from "@/lib/api"
import { cardKey } from "@/lib/title-cards"
import { episodeCode } from "@/lib/format"
import { useLibrary } from "@/lib/library"
import { formatClock } from "@/lib/playback"
import { tmdbImage } from "@/lib/tmdb-image"
import { cn } from "@/lib/utils"
import { Button } from "@/components/ui/button"
import { ProgressBar } from "@/components/ui/progress-bar"
import { Skeleton } from "@/components/ui/skeleton"

/** How often the list refreshes while the page is open. */
const POLL_MS = 5000

/** How each kind of device is drawn. */
const DEVICES: Record<PlaybackDevice, { label: string; icon: Icon }> = {
  browser: { label: "Browser", icon: MonitorIcon },
  cast: { label: "Chromecast", icon: ScreencastIcon },
  dlna: { label: "TV", icon: TelevisionSimpleIcon },
}

/** How each session sends its file, in a word or two. */
const MODES: Record<NowPlayingRecord["mode"], string> = {
  direct: "Original file",
  remux: "Original streams",
  audio: "Audio converted",
  transcode: "Video converted",
}

/**
 * The top of the Playback settings section: who is watching what right now,
 * on which device and how it is being sent, with a way to stop any of it;
 * and a test of the configured video encoder.
 */
export function PlaybackStatusPanel() {
  const [sessions, setSessions] = React.useState<NowPlayingRecord[] | null>(null)
  const [error, setError] = React.useState<string | null>(null)

  const load = React.useCallback((signal?: AbortSignal) => {
    fetchNowPlaying({ signal })
      .then((next) => {
        setSessions(next)
        setError(null)
      })
      .catch((reason: unknown) => {
        if (!signal?.aborted) setError(reason instanceof Error ? reason.message : "Could not load what is playing")
      })
  }, [])

  React.useEffect(() => {
    const controller = new AbortController()
    load(controller.signal)
    const timer = window.setInterval(() => load(controller.signal), POLL_MS)
    return () => {
      controller.abort()
      window.clearInterval(timer)
    }
  }, [load])

  async function stop(id: string) {
    setSessions((current) => current?.filter((session) => session.id !== id) ?? null)
    await stopNowPlaying(id).catch(() => {})
    load()
  }

  return (
    <div className="space-y-3">
      <div className="rounded-panel bg-sunken px-4 py-3.5">
        <p className="text-micro font-semibold text-ink-3">Now playing</p>
        {error ? (
          <p className="mt-1 text-[0.8125rem] text-ink-2">{error}</p>
        ) : sessions === null ? (
          <Skeleton className="mt-2 h-12 rounded-[0.75rem]" />
        ) : sessions.length === 0 ? (
          <p className="mt-1 text-[0.8125rem] text-ink-2">Nobody is watching right now.</p>
        ) : (
          <ul className="mt-2 divide-y divide-line">
            {sessions.map((session) => (
              <NowPlayingRow key={session.id} session={session} onStop={() => void stop(session.id)} />
            ))}
          </ul>
        )}
      </div>
      <EncoderTest />
    </div>
  )
}

function NowPlayingRow({ session, onStop }: { session: NowPlayingRecord; onStop: () => void }) {
  const { byKey } = useLibrary()
  const card = byKey.get(cardKey(session.mediaType, session.tmdbId))?.card
  const device = DEVICES[session.device]
  const DeviceIcon = device.icon
  const poster = tmdbImage(card?.posterPath, "thumb")
  const code = session.season !== null && session.episode !== null ? episodeCode(session.season, session.episode) : null

  return (
    <li className="flex items-center gap-3 py-2.5">
      <div className="h-14 w-10 shrink-0 overflow-hidden rounded-[0.5rem] bg-surface shadow-ring">
        {poster && <img src={poster} alt="" loading="lazy" className="size-full object-cover" />}
      </div>
      <div className="min-w-0 flex-1">
        <p className="truncate text-[0.875rem] font-semibold text-ink">
          {card?.title ?? "Unknown title"}
          {code && <span className="ml-1.5 font-mono font-medium text-ink-2 tabular">{code}</span>}
        </p>
        <p className="mt-0.5 flex min-w-0 items-center gap-1.5 truncate text-micro text-ink-3">
          <DeviceIcon aria-hidden weight="bold" className="size-3.5 shrink-0" />
          <span className="truncate">
            {session.user?.name || session.user?.email || "Unknown user"} · {session.deviceName ?? device.label} · {MODES[session.mode]}
            {session.mode === "transcode" && (session.hardware ? " on hardware" : " on CPU")}
          </span>
        </p>
        <div className="mt-1.5 flex items-center gap-2">
          <ProgressBar value={session.durationMs > 0 ? session.positionMs / session.durationMs : 0} label="Position" size="hair" className="max-w-48" />
          <span className="font-mono text-micro text-ink-3 tabular">{formatClock(session.positionMs)}</span>
        </div>
      </div>
      <Button variant="ghost" size="sm" icon={StopIcon} onClick={onStop} aria-label={`Stop ${card?.title ?? "this session"}`}>
        Stop
      </Button>
    </li>
  )
}

/** Runs the saved encoder on a test picture and says whether it worked. */
function EncoderTest() {
  const [result, setResult] = React.useState<EncoderTestResult | null>(null)
  const [running, setRunning] = React.useState(false)

  async function run() {
    setRunning(true)
    try {
      setResult(await testEncoder())
    } catch (reason) {
      setResult({ ok: false, encoder: "", message: reason instanceof Error ? reason.message : "The test could not run" })
    } finally {
      setRunning(false)
    }
  }

  const ResultIcon = result?.ok ? CheckCircleIcon : WarningCircleIcon
  return (
    <div className="flex flex-col gap-3 rounded-panel bg-sunken px-4 py-3.5 sm:flex-row sm:items-center sm:justify-between">
      <div className="min-w-0 space-y-1">
        <p className="text-micro font-semibold text-ink-3">Video encoder</p>
        <p className={cn("flex items-start gap-1.5 text-[0.8125rem] leading-relaxed", result ? (result.ok ? "text-ok" : "text-bad") : "text-ink-2")} aria-live="polite">
          {result && <ResultIcon aria-hidden weight="bold" className="mt-0.5 size-4 shrink-0" />}
          <span className="min-w-0 [overflow-wrap:anywhere]">
            {result ? `${result.encoder ? `${result.encoder}: ` : ""}${result.message}` : "Checks the saved encoder setting by converting a few seconds of a test picture."}
          </span>
        </p>
      </div>
      <Button size="sm" icon={CpuIcon} loading={running} onClick={() => void run()} className="shrink-0 self-start sm:self-center">
        Test encoder
      </Button>
    </div>
  )
}
