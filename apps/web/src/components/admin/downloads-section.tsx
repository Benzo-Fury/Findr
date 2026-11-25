import * as React from "react"
import { motion } from "motion/react"
import { CheckCircleIcon, ClockIcon, DownloadSimpleIcon, GaugeIcon, type Icon } from "@phosphor-icons/react"
import type { AdminDownloads, AttemptStep } from "@findr/types/admin"
import { formatBytes, formatDuration, plural } from "@/lib/format"
import { EASE_OUT } from "@/lib/motion"
import { cn } from "@/lib/utils"
import { AreaChart, EmptyNote, Figure, Histogram, HourStrip, OutcomeColumns, Panel, RankBars } from "@/components/admin/charts"
import { dayName, formatSpeed, median, outcomesByDay, speedByDay, speedByHour } from "@/components/admin/series"

/** Each timed step, named for what happens in it. */
const STEPS: Record<AttemptStep, { label: string; detail: string; tone: string }> = {
  metadata: { label: "Connecting", detail: "Finding peers and the file list", tone: "bg-ink-3" },
  downloading: { label: "Downloading", detail: "Fetching the chosen files", tone: "bg-signal" },
  sterilizing: { label: "Cleaning", detail: "Keeping only video and audio", tone: "bg-ink" },
  saving: { label: "Saving", detail: "Moving into the library", tone: "bg-ink-2" },
}

interface DownloadsSectionProps {
  downloads: AdminDownloads
  /** The start of each day in the period, for the daily charts. */
  days: number[]
}

/** How downloads went over the period, headline numbers first. */
export function DownloadsSection({ downloads, days }: DownloadsSectionProps) {
  const dayLabel = React.useCallback((index: number) => (index === days.length - 1 ? "Today" : dayName(days[index] ?? Date.now())), [days])
  const daily = React.useMemo(() => speedByDay(days, downloads.speeds), [days, downloads.speeds])
  const hourly = React.useMemo(() => speedByHour(downloads.speeds), [downloads.speeds])
  const outcomes = React.useMemo(() => outcomesByDay(days, downloads.finished), [days, downloads.finished])
  const averageSpeed =
    downloads.speeds.length === 0 ? null : downloads.speeds.reduce((sum, sample) => sum + sample.bytesPerSecond, 0) / downloads.speeds.length

  const finishedCount = downloads.finished.length
  const saved = downloads.releasesTried.reduce((sum, row) => sum + row.count, 0)
  const firstPick = downloads.releasesTried.find((row) => row.releases === 1)?.count ?? 0
  const drops = downloads.dropReasons.reduce((sum, row) => sum + row.count, 0)

  return (
    <>
      <HeadlineFigures downloads={downloads} averageSpeed={averageSpeed} />

      <div className="mt-6 grid grid-cols-1 gap-4 lg:grid-cols-12">
        <Panel
          title="Download speed"
          description="How fast releases downloaded, in megabytes per second. Each day shows the average of the downloads that finished that day."
          aside={averageSpeed === null ? undefined : `${formatSpeed(averageSpeed)} average`}
          className="lg:col-span-8"
        >
          {downloads.speeds.length === 0 ? (
            <EmptyNote>Speeds show up here once downloads finish. Findr times every download from now on.</EmptyNote>
          ) : (
            <>
              <AreaChart
                values={daily.map((value) => (value === null ? null : value / (1024 * 1024)))}
                unit="MB/s"
                format={(value) => (value >= 10 ? value.toFixed(0) : value.toFixed(1))}
                slotLabel={dayLabel}
                emptyLabel="no downloads finished"
              />
              <div className="mt-8 border-t border-line pt-5">
                <h4 className="text-sm font-medium text-ink">Speed by time of day</h4>
                <p className="mb-3 mt-0.5 text-[0.8125rem] text-ink-2">The same downloads grouped by the hour they finished in, to show when your connection is fastest.</p>
                <HourStrip values={hourly} format={formatSpeed} />
              </div>
            </>
          )}
        </Panel>

        <Panel
          title="Releases tried per download"
          description="When a release turns out bad, Findr drops it and tries the next best. Each bar counts the saved files that took that many releases."
          aside={saved > 0 ? `${plural(saved, "file")} saved` : undefined}
          className="lg:col-span-4"
        >
          {saved === 0 ? (
            <EmptyNote>Nothing reached the library in this period.</EmptyNote>
          ) : (
            <>
              <Histogram
                items={downloads.releasesTried.map((row) => ({ label: row.releases === 5 ? "5+" : String(row.releases), count: row.count }))}
                caption="Releases tried, the one that worked included"
                countLabel="Files"
              />
              <p className="mt-4 text-sm text-ink-2">
                <span className="font-semibold text-ink">{Math.round((firstPick / saved) * 100)}%</span> worked with the first release Findr picked.
              </p>
            </>
          )}
        </Panel>

        <Panel title="Finished downloads by day" description="Every request that finished, on the day it finished, coloured by how it ended." aside={finishedCount > 0 ? plural(finishedCount, "download") : undefined} className="lg:col-span-7">
          {finishedCount === 0 ? <EmptyNote>No downloads finished in this period.</EmptyNote> : <OutcomeColumns days={outcomes} dayLabel={dayLabel} />}
        </Panel>

        <Panel
          title="Why Findr dropped a release"
          description="Each time a release went wrong, Findr gave up on it and moved to the next best. The number is how often each reason came up."
          aside={drops > 0 ? `${plural(drops, "release")} dropped` : undefined}
          className="lg:col-span-5"
        >
          {drops === 0 ? (
            <EmptyNote>No release was dropped in this period.</EmptyNote>
          ) : (
            <RankBars items={downloads.dropReasons.map((row) => ({ label: row.reason, count: row.count }))} format={(count) => plural(count, "time")} />
          )}
        </Panel>

        <StepTrack downloads={downloads} className="lg:col-span-12" />
        <IndexerTable downloads={downloads} className="lg:col-span-12" />
      </div>
    </>
  )
}

/** Four numbers in a row, split by hairlines rather than boxed. */
function HeadlineFigures({ downloads, averageSpeed }: { downloads: AdminDownloads; averageSpeed: number | null }) {
  const ended = downloads.finished.filter((row) => row.status !== "cancelled")
  const succeeded = ended.filter((row) => row.status === "completed").length
  const wait = median(downloads.finished.filter((row) => row.status === "completed").map((row) => row.durationMs))

  const figures: Array<{ label: string; icon: Icon; value: number | null; format: (value: number) => string; unit?: string }> = [
    { label: "Requested", icon: DownloadSimpleIcon, value: downloads.requested, format: (value) => Math.round(value).toLocaleString() },
    { label: "Saved in full", icon: CheckCircleIcon, value: ended.length === 0 ? null : (succeeded / ended.length) * 100, format: (value) => `${Math.round(value)}%` },
    { label: "Average speed", icon: GaugeIcon, value: averageSpeed === null ? null : averageSpeed / (1024 * 1024), format: (value) => value.toFixed(1), unit: "MB/s" },
    { label: "Typical wait", icon: ClockIcon, value: wait, format: (value) => formatDuration(value) },
  ]

  return (
    <div className="grid grid-cols-2 gap-y-6 lg:grid-cols-4">
      {figures.map((figure, index) => (
        <div key={figure.label} className={cn("min-w-0 border-line", index % 2 === 1 && "border-l pl-4 lg:pl-6", index === 2 && "lg:border-l lg:pl-6")}>
          <p className="flex items-center gap-1.5 text-[0.8125rem] text-ink-2">
            <figure.icon aria-hidden weight="bold" className="size-3.5" />
            {figure.label}
          </p>
          <p className="display mt-2 truncate text-[2.75rem] text-ink sm:text-5xl md:text-6xl">
            {figure.value === null ? <span className="text-ink-3">–</span> : <Figure value={figure.value} format={figure.format} />}
            {figure.unit && figure.value !== null && <span className="heading ml-1.5 text-lg text-ink-3">{figure.unit}</span>}
          </p>
        </div>
      ))}
      <p className="col-span-2 text-[0.8125rem] text-ink-3 lg:col-span-4">
        Saved in full counts finished downloads, cancelled ones aside. Typical wait is the median time from a request to the library.
      </p>
    </div>
  )
}

/** Where a successful download spends its time, as one track split by step. */
function StepTrack({ downloads, className }: { downloads: AdminDownloads; className?: string }) {
  const [hovered, setHovered] = React.useState<AttemptStep | null>(null)
  const total = downloads.steps.reduce((sum, step) => sum + step.medianMs, 0)

  return (
    <Panel
      title="Where the time goes"
      description="The typical time each step took, for downloads that reached the library."
      aside={total > 0 ? `about ${formatDuration(total)} in all` : undefined}
      className={className}
    >
      {total === 0 ? (
        <EmptyNote>Step times show up once a download finishes. Findr times every step from now on.</EmptyNote>
      ) : (
        <>
          <div className="flex h-12 gap-1" onMouseLeave={() => setHovered(null)}>
            {downloads.steps.map((step, index) => (
              <motion.div
                key={step.step}
                onMouseEnter={() => setHovered(step.step)}
                initial={{ scaleX: 0, opacity: 0 }}
                whileInView={{ scaleX: 1, opacity: 1 }}
                viewport={{ once: true }}
                transition={{ delay: index * 0.1, duration: 0.6, ease: EASE_OUT }}
                className={cn(
                  "h-full min-w-2 origin-left rounded-[6px] transition-opacity duration-200",
                  STEPS[step.step].tone,
                  hovered && hovered !== step.step && "opacity-30",
                )}
                style={{ flexGrow: step.medianMs, flexBasis: 0 }}
              />
            ))}
          </div>
          <div className="mt-5 grid grid-cols-2 gap-x-6 gap-y-4 lg:grid-cols-4">
            {downloads.steps.map((step) => (
              <div
                key={step.step}
                onMouseEnter={() => setHovered(step.step)}
                onMouseLeave={() => setHovered(null)}
                className={cn("transition-opacity duration-200", hovered && hovered !== step.step && "opacity-40")}
              >
                <p className="flex items-center gap-1.5 text-[0.8125rem] font-medium text-ink">
                  <span className={cn("size-2 rounded-full", STEPS[step.step].tone)} />
                  {STEPS[step.step].label}
                </p>
                <p className="heading mt-1 text-2xl text-ink tabular">{formatDuration(step.medianMs)}</p>
                <p className="text-micro text-ink-3">{STEPS[step.step].detail}</p>
              </div>
            ))}
          </div>
          <p className="mt-4 text-micro text-ink-3">From {plural(downloads.timedReleases, "download")}. Searching and waiting in the queue aren't counted.</p>
        </>
      )}
    </Panel>
  )
}

/** How each indexer's releases did, the best success rate picked out. */
function IndexerTable({ downloads, className }: { downloads: AdminDownloads; className?: string }) {
  const rate = (worked: number, tried: number) => (tried === 0 ? null : worked / tried)
  const best = Math.max(0, ...downloads.indexers.map((row) => rate(row.worked, row.tried) ?? 0))

  return (
    <Panel
      title="Indexers"
      description="Where releases came from. Found is every result searches returned, tried is how many Findr downloaded, and worked is the share of those that reached the library."
      aside={downloads.indexers.length > 0 ? plural(downloads.indexers.length, "indexer") : undefined}
      className={className}
    >
      {downloads.indexers.length === 0 ? (
        <EmptyNote>No searches ran in this period.</EmptyNote>
      ) : (
        <div className="scroll-x -mx-5 px-5 md:-mx-6 md:px-6">
          <table className="w-full min-w-[38rem] text-left text-sm">
            <thead>
              <tr className="text-[0.8125rem] text-ink-3">
                <th className="pb-3 font-medium">Indexer</th>
                <th className="pb-3 text-right font-medium">Found</th>
                <th className="pb-3 text-right font-medium">Tried</th>
                <th className="pb-3 pl-6 font-medium">Worked</th>
                <th className="pb-3 text-right font-medium" title="Median size of the releases tried">Typical size</th>
                <th className="pb-3 text-right font-medium" title="Average download speed of its releases that finished">Avg speed</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-line">
              {downloads.indexers.map((row) => {
                const share = rate(row.worked, row.tried)
                return (
                  <tr key={row.name} className="transition-colors hover:bg-paper">
                    <td className="py-3 font-medium text-ink">{row.name}</td>
                    <td className="py-3 text-right font-mono text-ink-2 tabular">{row.found.toLocaleString()}</td>
                    <td className="py-3 text-right font-mono text-ink-2 tabular">{row.tried}</td>
                    <td className="py-3 pl-6">
                      {share === null ? (
                        <span className="font-mono text-ink-3">–</span>
                      ) : (
                        <span className="flex items-center gap-3">
                          <span className="w-12 font-mono text-ink tabular">{Math.round(share * 100)}%</span>
                          <span className="block h-1.5 w-20 rounded-full bg-sunken">
                            <motion.span
                              initial={{ scaleX: 0 }}
                              whileInView={{ scaleX: 1 }}
                              viewport={{ once: true }}
                              transition={{ duration: 0.6, ease: EASE_OUT }}
                              className={cn("block h-full origin-left rounded-full", share === best ? "bg-signal" : "bg-ink/25")}
                              style={{ width: `${share * 100}%` }}
                            />
                          </span>
                        </span>
                      )}
                    </td>
                    <td className="py-3 text-right font-mono text-ink-2 tabular">{row.medianBytes === null ? "–" : formatBytes(row.medianBytes)}</td>
                    <td className="py-3 text-right font-mono text-ink-2 tabular">{row.bytesPerSecond === null ? "–" : formatSpeed(row.bytesPerSecond)}</td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      )}
    </Panel>
  )
}
