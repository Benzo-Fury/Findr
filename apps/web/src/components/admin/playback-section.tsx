import { motion } from "motion/react"
import type { AdminPlayback, DeliveryKind } from "@findr/types/admin"
import type { NowPlayingRecord, TranscodeRung } from "@findr/types/playback"
import { episodeCode, formatDuration, plural } from "@/lib/format"
import { EASE_OUT } from "@/lib/motion"
import { cardKey, type useTitleCards } from "@/lib/title-cards"
import { cn } from "@/lib/utils"
import { EmptyNote, Panel, RankBars, ShareBar } from "@/components/admin/charts"
import { shares } from "@/components/admin/series"

/** How each way of sending a file reads, simplest first. */
const DELIVERY: Record<DeliveryKind, string> = {
  direct: "Sent as the file",
  copied: "Repackaged, not converted",
  audio: "Audio converted",
  video: "Video converted",
}
const DELIVERY_ORDER: DeliveryKind[] = ["direct", "copied", "audio", "video"]

/** Where a video conversion ran, most on the hardware first. */
const RUNGS: Record<TranscodeRung, string> = {
  device: "All on the GPU",
  decode: "GPU, CPU tone mapping",
  encode: "GPU encoding only",
  cpu: "CPU",
}
const RUNG_ORDER: TranscodeRung[] = ["device", "decode", "encode", "cpu"]

/** A live session's mode in a word, and its tone. */
const MODE_PILL: Record<NowPlayingRecord["mode"], { label: string; className: string }> = {
  direct: { label: "Direct", className: "bg-ok-soft text-ok" },
  remux: { label: "Repackaged", className: "bg-ok-soft text-ok" },
  audio: { label: "Audio converted", className: "bg-warn-soft text-warn" },
  transcode: { label: "Converting", className: "bg-warn-soft text-warn" },
}

const DEVICE_NAMES: Record<NowPlayingRecord["device"], string> = { browser: "Browser", cast: "Chromecast", dlna: "TV" }

interface PlaybackSectionProps {
  playback: AdminPlayback
  /** What plays now; null when playback is off or the list couldn't load. */
  nowPlaying: NowPlayingRecord[] | null
  cards: ReturnType<typeof useTitleCards>
}

/** How the library is watched: live streams, how plays were sent, the most watched titles and who watches. */
export function PlaybackSection({ playback, nowPlaying, cards }: PlaybackSectionProps) {
  const delivery = shares(DELIVERY_ORDER.map((kind) => ({ label: DELIVERY[kind], count: playback.delivery.find((row) => row.kind === kind)?.count ?? 0 })).filter((part) => part.count > 0))
  const rungs = shares(RUNG_ORDER.map((rung) => ({ label: RUNGS[rung], count: playback.rungs.find((row) => row.rung === rung)?.count ?? 0 })).filter((part) => part.count > 0))
  const { credits } = playback

  return (
    <div className="grid grid-cols-1 gap-4 lg:grid-cols-12">
      <NowPlaying sessions={nowPlaying} cards={cards} className="lg:col-span-5" />

      <Panel
        title="How plays were streamed"
        description="Copying a file as it is costs the server almost nothing; converting video is the heavy work."
        aside={playback.plays > 0 ? plural(playback.plays, "play") : undefined}
        className="lg:col-span-7"
      >
        <div className="flex flex-col gap-7">
          {delivery.length === 0 ? (
            <EmptyNote>Plays of a minute or more are counted from now on, and show up here.</EmptyNote>
          ) : (
            <div>
              <p className="mb-3 text-sm text-ink-2">Each play</p>
              <ShareBar parts={delivery} highlight={0} size="md" />
            </div>
          )}
          {rungs.length > 0 && (
            <div>
              <p className="mb-3 text-sm text-ink-2">Where video conversions ran</p>
              <ShareBar parts={rungs} size="md" />
            </div>
          )}
          {credits.episodes > 0 && (
            <p className="text-sm text-ink-2">
              End credits found for <span className="font-semibold text-ink">{Math.round((credits.found / credits.episodes) * 100)}%</span> of episodes
              {credits.found > 0 && `, ${Math.round((credits.online / credits.found) * 100)}% of them looked up online rather than read from the file`}. That's what
              times the Next episode button.
            </p>
          )}
        </div>
      </Panel>

      <Panel title="Most watched" description="Titles by time spent watching them in this period, across everyone." className="lg:col-span-5">
        {playback.mostWatched.length === 0 ? (
          <EmptyNote>Nothing was watched in this period.</EmptyNote>
        ) : (
          <RankBars
            items={playback.mostWatched.map((title) => ({ id: title.titleId, label: cards(cardKey(title.mediaType, title.tmdbId))?.title ?? "Loading…", count: title.watchedMs }))}
            format={formatDuration}
          />
        )}
      </Panel>

      <PeoplePanel playback={playback} className="lg:col-span-7" />
    </div>
  )
}

/** What is playing right now, refreshed while the page is open. */
function NowPlaying({ sessions, cards, className }: { sessions: NowPlayingRecord[] | null; cards: PlaybackSectionProps["cards"]; className?: string }) {
  return (
    <Panel title="Playing now" aside={sessions && sessions.length > 0 ? plural(sessions.length, "stream") : undefined} className={className}>
      {sessions === null ? (
        <EmptyNote>Playback is turned off, so nothing can play.</EmptyNote>
      ) : sessions.length === 0 ? (
        <EmptyNote>Nobody is watching right now.</EmptyNote>
      ) : (
        <ul className="flex flex-col gap-5">
          {sessions.map((session) => {
            const card = cards(cardKey(session.mediaType, session.tmdbId))
            const pill = MODE_PILL[session.mode]
            const where = session.deviceName ?? DEVICE_NAMES[session.device]
            const name = session.user?.name || session.user?.email || "Someone"
            return (
              <li key={session.id} className="flex items-start gap-3">
                <Initials name={name} />
                <div className="min-w-0 flex-1">
                  <div className="flex items-baseline justify-between gap-2">
                    <p className="truncate text-sm font-semibold text-ink">
                      {card?.title ?? "Loading…"}
                      {session.season !== null && <span className="font-normal text-ink-2"> {episodeCode(session.season, session.episode)}</span>}
                    </p>
                    <span className={cn("shrink-0 rounded-full px-2 py-0.5 text-micro font-medium", pill.className)}>{pill.label}</span>
                  </div>
                  <p className="truncate text-[0.8125rem] text-ink-2">
                    {name} on {where}
                  </p>
                  <div className="mt-2 h-1 overflow-hidden rounded-full bg-sunken">
                    <motion.div
                      initial={false}
                      animate={{ scaleX: session.durationMs > 0 ? session.positionMs / session.durationMs : 0 }}
                      transition={{ duration: 0.8, ease: EASE_OUT }}
                      className="h-full w-full origin-left rounded-full bg-signal"
                    />
                  </div>
                </div>
              </li>
            )
          })}
        </ul>
      )}
    </Panel>
  )
}

/** Each account's requests and viewing, the busiest viewer first. */
function PeoplePanel({ playback, className }: { playback: AdminPlayback; className?: string }) {
  const most = Math.max(1, ...playback.people.map((person) => person.watchedMs))

  return (
    <Panel title="People" description="How many downloads each account requested, and how long it spent watching, in this period." aside={plural(playback.people.length, "account")} className={className}>
      <ul className="flex flex-col gap-4">
        {playback.people.map((person) => {
          const name = person.name || person.email
          return (
            <li key={person.id} className="grid grid-cols-[auto_1fr] items-center gap-x-3 gap-y-1 sm:grid-cols-[auto_1fr_auto]">
              <Initials name={name} className="row-span-2 sm:row-span-1" />
              <div className="min-w-0">
                <p className="flex items-baseline gap-2 text-sm">
                  <span className="truncate font-semibold text-ink">{name}</span>
                  {person.admin && <span className="text-micro text-ink-3">Admin</span>}
                </p>
                <div className="mt-1.5 h-1.5 rounded-full bg-sunken">
                  <motion.div
                    initial={{ scaleX: 0 }}
                    whileInView={{ scaleX: 1 }}
                    viewport={{ once: true }}
                    transition={{ duration: 0.7, ease: EASE_OUT }}
                    className="h-full origin-left rounded-full bg-ink/25"
                    style={{ width: `${(person.watchedMs / most) * 100}%` }}
                  />
                </div>
              </div>
              <div className="col-start-2 flex gap-4 font-mono text-[0.8125rem] tabular sm:col-start-3 sm:row-start-1 sm:text-right">
                <span title="Downloads requested">
                  <span className="text-ink">{person.requests}</span> <span className="text-ink-3">{person.requests === 1 ? "request" : "requests"}</span>
                </span>
                <span title="Time watched">
                  <span className="text-ink">{person.watchedMs > 0 ? formatDuration(person.watchedMs) : "0h"}</span> <span className="text-ink-3">watched</span>
                </span>
              </div>
            </li>
          )
        })}
      </ul>
    </Panel>
  )
}

/** Up to two initials in an ink circle. */
function Initials({ name, className }: { name: string; className?: string }) {
  const letters = name
    .split(/[\s@._-]/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase() ?? "")
    .join("")
  return (
    <span className={cn("flex size-9 shrink-0 items-center justify-center rounded-full bg-ink font-display text-[0.8125rem] font-semibold text-surface", className)}>
      {letters}
    </span>
  )
}
