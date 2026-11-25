import * as React from "react"
import { animate, motion, useInView, useMotionValue, useReducedMotion, useTransform } from "motion/react"
import { EASE_OUT, staggerDelay } from "@/lib/motion"
import { cn } from "@/lib/utils"

/**
 * The Admin page's small chart kit: a counting figure, a titled panel, and
 * the handful of charts the page draws. All of it is plain SVG and divs on
 * the app's tokens, so it needs no charting library.
 */

/* ------------------------------------------------------------------ */
/* Figures and panels                                                  */
/* ------------------------------------------------------------------ */

interface FigureProps {
  value: number
  format: (value: number) => string
  className?: string
}

/** A number that counts up to its value when it first appears or changes. */
export function Figure({ value, format, className }: FigureProps) {
  const reduce = useReducedMotion()
  const current = useMotionValue(reduce ? value : 0)
  const text = useTransform(current, (latest) => format(latest))

  // Count from wherever it is now, straight to the value under reduced motion
  React.useEffect(() => {
    if (reduce) {
      current.set(value)
      return
    }
    const controls = animate(current, value, { duration: 0.9, ease: EASE_OUT })
    return () => controls.stop()
  }, [value, reduce, current])

  return <motion.span className={cn("tabular", className)}>{text}</motion.span>
}

interface PanelProps {
  title: string
  /** One plain sentence under the title saying what the panel shows. */
  description?: string
  /** A short value set at the right of the title, such as a total. */
  aside?: React.ReactNode
  className?: string
  children: React.ReactNode
}

/** A titled panel, fading up as it scrolls into view. */
export function Panel({ title, description, aside, className, children }: PanelProps) {
  return (
    <motion.section
      initial={{ opacity: 0, y: 18 }}
      whileInView={{ opacity: 1, y: 0 }}
      viewport={{ once: true, amount: 0.2 }}
      transition={{ duration: 0.55, ease: EASE_OUT }}
      className={cn("flex flex-col rounded-panel bg-surface p-5 shadow-ring md:p-6", className)}
    >
      <header className="mb-5">
        <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
          <h3 className="heading text-lg text-ink">{title}</h3>
          {aside && <div className="font-mono text-[0.8125rem] text-ink-2 tabular">{aside}</div>}
        </div>
        {description && <p className="mt-1 max-w-[60ch] text-[0.8125rem] leading-relaxed text-ink-2">{description}</p>}
      </header>
      {children}
    </motion.section>
  )
}

/** What a panel shows before there is anything to chart. */
export function EmptyNote({ children, className }: { children: React.ReactNode; className?: string }) {
  return (
    <div
      className={cn("flex min-h-32 flex-1 items-center justify-center rounded-art px-6 py-8 text-center text-sm text-ink-2", className)}
      style={{ background: "repeating-linear-gradient(-45deg, var(--color-surface) 0 7px, var(--color-paper) 7px 9px)" }}
    >
      <p className="max-w-[36ch] leading-relaxed">{children}</p>
    </div>
  )
}

/* ------------------------------------------------------------------ */
/* Speed                                                               */
/* ------------------------------------------------------------------ */

/** A rounded-up axis maximum: 1, 2 or 5 times a power of ten. */
function niceCeiling(value: number): number {
  if (value <= 0) return 1
  const power = 10 ** Math.floor(Math.log10(value))
  return ([1, 2, 2.5, 5, 10].find((step) => step * power >= value) ?? 10) * power
}

/**
 * The line above a chart saying what the hovered or tapped slot holds, or a
 * hint before anything is picked. Fixed height, so the chart doesn't jump.
 */
function Readout({ children, hint }: { children: React.ReactNode; hint: string }) {
  return (
    <p aria-live="polite" className="mb-3 flex min-h-10 flex-wrap items-start gap-x-2 text-[0.8125rem] leading-5 sm:min-h-5">
      {children || <span className="text-ink-3">{hint}</span>}
    </p>
  )
}

/**
 * Which of `count` slots a pointer over the element is on: the nearest point
 * for a line whose points run edge to edge, or the column under it.
 */
function slotAt(event: React.PointerEvent<HTMLElement>, count: number, layout: "points" | "columns"): number {
  const box = event.currentTarget.getBoundingClientRect()
  const fraction = Math.min(Math.max((event.clientX - box.left) / box.width, 0), 1)
  return layout === "points" ? Math.round(fraction * (count - 1)) : Math.min(Math.floor(fraction * count), count - 1)
}

interface AreaChartProps {
  /** One value per slot, oldest first; null where there was nothing to measure. */
  values: Array<number | null>
  /** The unit the axis is in, shown over it, such as "MB/s". */
  unit: string
  /** Formats a value for the axis, without its unit. */
  format: (value: number) => string
  /** Names a slot, such as its date, for the readout and the axis. */
  slotLabel: (index: number) => string
  /** What a slot with no value means, for the readout. */
  emptyLabel: string
  className?: string
}

/**
 * A filled line over time, drawn left to right as it appears, with its peak
 * marked. Hovering or tapping picks the nearest slot and reads it out above.
 */
export function AreaChart({ values, unit, format, slotLabel, emptyLabel, className }: AreaChartProps) {
  const gradientId = React.useId()
  const [picked, setPicked] = React.useState<number | null>(null)
  const width = 600
  const height = 180
  const measured = values.filter((value): value is number => value !== null)
  const top = Math.max(...measured, 0)
  const max = niceCeiling(top)

  // Points at their slot across the full width, the highest value near the top
  const xOf = (index: number) => (values.length === 1 ? width / 2 : (index / (values.length - 1)) * width)
  const yOf = (value: number) => height - (value / max) * height
  const points = values.flatMap((value, index) => (value === null ? [] : [[xOf(index), yOf(value), index] as const]))
  const line = points.map(([x, y], index) => `${index === 0 ? "M" : "L"}${x.toFixed(1)},${y.toFixed(1)}`).join(" ")
  const first = points[0]?.[0] ?? 0
  const last = points[points.length - 1]?.[0] ?? width
  const area = `${line} L${last},${height} L${first},${height} Z`
  const peak = points.find(([, , index]) => values[index] === top)
  const marked = picked === null ? peak : ([xOf(picked), yOf(values[picked] ?? 0), picked] as const)
  const pickedValue = picked === null ? undefined : values[picked]
  const middle = Math.floor((values.length - 1) / 2)

  return (
    <div className={className}>
      <Readout hint={`Peak ${format(top)} ${unit} on ${peak ? slotLabel(peak[2]) : "–"}. Hover or tap the chart for any day.`}>
        {picked !== null && (
          <>
            <span className="font-medium text-ink">{slotLabel(picked)}</span>
            <span className="font-mono text-ink-2 tabular">{pickedValue === null || pickedValue === undefined ? emptyLabel : `${format(pickedValue)} ${unit}`}</span>
          </>
        )}
      </Readout>
      <div className="relative mt-6">
        {/* The axis: its unit over the top value, each number level with its gridline */}
        <span className="pointer-events-none absolute -top-6 left-0 font-mono text-micro text-ink-3">{unit}</span>
        <div className="pointer-events-none absolute left-0 top-0 h-44 w-10 font-mono text-micro text-ink-3 tabular">
          <span className="absolute top-0 -translate-y-1/2">{format(max)}</span>
          <span className="absolute top-1/2 -translate-y-1/2">{format(max / 2)}</span>
          <span className="absolute bottom-0 translate-y-1/2">0</span>
        </div>
        <div
          className="relative ml-10 h-44 cursor-crosshair touch-pan-y"
          onPointerMove={(event) => setPicked(slotAt(event, values.length, "points"))}
          onPointerDown={(event) => setPicked(slotAt(event, values.length, "points"))}
          onPointerLeave={(event) => event.pointerType === "mouse" && setPicked(null)}
        >
          {/* Revealed left to right by a clip: a drawn-on stroke would mismeasure a stretched, non-scaling line */}
          <motion.svg
            key={line}
            viewBox={`0 0 ${width} ${height}`}
            preserveAspectRatio="none"
            className="h-full w-full overflow-visible"
            initial={{ clipPath: "inset(-10% 100% -10% 0)" }}
            animate={{ clipPath: "inset(-10% 0% -10% 0)" }}
            transition={{ duration: 1.1, ease: EASE_OUT }}
          >
            <defs>
              <linearGradient id={gradientId} x1="0" x2="0" y1="0" y2="1">
                <stop offset="0%" stopColor="var(--color-signal)" stopOpacity="0.45" />
                <stop offset="100%" stopColor="var(--color-signal)" stopOpacity="0" />
              </linearGradient>
            </defs>
            {[0, 0.5, 1].map((fraction) => (
              <line
                key={fraction}
                x1="0"
                x2={width}
                y1={height - fraction * height}
                y2={height - fraction * height}
                stroke={fraction === 0 ? "var(--color-line-strong)" : "var(--color-line)"}
                strokeDasharray={fraction === 0 ? undefined : "3 5"}
                vectorEffect="non-scaling-stroke"
              />
            ))}
            <path d={area} fill={`url(#${gradientId})`} />
            <path d={line} fill="none" stroke="var(--color-signal-strong)" strokeWidth="2" strokeLinejoin="round" vectorEffect="non-scaling-stroke" />
            {picked !== null && (
              <line x1={xOf(picked)} x2={xOf(picked)} y1="0" y2={height} stroke="var(--color-ink-3)" strokeDasharray="2 3" vectorEffect="non-scaling-stroke" />
            )}
          </motion.svg>
          {marked && values[marked[2]] !== null && (
            <span
              className="pointer-events-none absolute size-2.5 -translate-x-1/2 -translate-y-1/2 rounded-full bg-ink ring-4 ring-surface"
              style={{ left: `${(marked[0] / width) * 100}%`, top: `${(marked[1] / height) * 100}%` }}
            />
          )}
        </div>
        <div className="ml-10 mt-2 grid grid-cols-3 font-mono text-micro text-ink-3">
          <span>{slotLabel(0)}</span>
          <span className="text-center">{values.length > 2 ? slotLabel(middle) : ""}</span>
          <span className="text-right">{slotLabel(values.length - 1)}</span>
        </div>
      </div>
    </div>
  )
}

/** "14:00" for an hour of the day. */
const hourName = (hour: number) => `${String(hour).padStart(2, "0")}:00`

interface HourStripProps {
  /** One value per hour from midnight; null for hours with nothing measured. */
  values: Array<number | null>
  /** Formats a value with its unit. */
  format: (value: number) => string
}

/**
 * Twenty-four cells, one per hour of the day, brighter the faster that hour
 * ran, with a key and a readout of the hovered or tapped hour.
 */
export function HourStrip({ values, format }: HourStripProps) {
  const [picked, setPicked] = React.useState<number | null>(null)
  const measured = values.filter((value): value is number => value !== null)
  const max = Math.max(...measured)
  const min = Math.min(...measured)
  const fastest = values.indexOf(max)
  const tone = (strength: number) => `color-mix(in srgb, var(--color-signal) ${Math.round(15 + strength * 85)}%, var(--color-sunken))`
  const hatch = "repeating-linear-gradient(-45deg, var(--color-surface) 0 3px, var(--color-sunken) 3px 5px)"
  const pickedValue = picked === null ? null : values[picked]

  return (
    <div>
      <Readout hint={`Fastest around ${hourName(fastest)}, ${format(max)} on average. Hover or tap an hour.`}>
        {picked !== null && (
          <>
            <span className="font-medium text-ink">
              {hourName(picked)}–{hourName((picked + 1) % 24)}
            </span>
            <span className="font-mono text-ink-2 tabular">{pickedValue === null || pickedValue === undefined ? "nothing finished then" : `${format(pickedValue)} on average`}</span>
          </>
        )}
      </Readout>
      <div className="grid gap-[3px]" style={{ gridTemplateColumns: "repeat(24, minmax(0, 1fr))" }} onPointerLeave={(event) => event.pointerType === "mouse" && setPicked(null)}>
        {values.map((value, hour) => {
          const strength = value === null ? 0 : (value - min) / (max - min || 1)
          return (
            <motion.button
              type="button"
              key={hour}
              aria-label={`${hourName(hour)}, ${value === null ? "nothing finished" : format(value)}`}
              onPointerEnter={() => setPicked(hour)}
              onFocus={() => setPicked(hour)}
              onClick={() => setPicked(hour)}
              initial={{ opacity: 0, scaleY: 0.3 }}
              whileInView={{ opacity: 1, scaleY: 1 }}
              viewport={{ once: true }}
              transition={{ delay: hour * 0.02, duration: 0.4, ease: EASE_OUT }}
              className={cn("h-9 origin-bottom rounded-[3px] outline-offset-2", picked === hour && "ring-2 ring-ink")}
              style={{ background: value === null ? hatch : tone(strength) }}
            />
          )
        })}
      </div>
      <div className="mt-1.5 grid grid-cols-4 font-mono text-micro text-ink-3">
        <span>00:00</span>
        <span>06:00</span>
        <span>12:00</span>
        <span>18:00</span>
      </div>

      {/* Key: the colour scale and what hatching means */}
      <div className="mt-3 flex flex-wrap items-center gap-x-5 gap-y-1.5 text-micro text-ink-2">
        <span className="inline-flex items-center gap-2">
          Slower
          <span className="h-2 w-16 rounded-full" style={{ background: `linear-gradient(to right, ${tone(0)}, ${tone(1)})` }} />
          Faster
        </span>
        <span className="inline-flex items-center gap-1.5">
          <span className="size-2.5 rounded-[2px]" style={{ background: hatch }} />
          No downloads finished
        </span>
      </div>
    </div>
  )
}

/* ------------------------------------------------------------------ */
/* Outcomes and counts                                                 */
/* ------------------------------------------------------------------ */

/** One day of finished downloads, by outcome. */
export interface DayOutcome {
  completed: number
  partial: number
  failed: number
  cancelled: number
}

/** The outcome order and colour, shared by the columns and their key. */
export const OUTCOME_TONES: { key: keyof DayOutcome; label: string; className: string }[] = [
  { key: "completed", label: "Saved", className: "bg-ink" },
  { key: "partial", label: "Some episodes", className: "bg-warn" },
  { key: "failed", label: "Failed", className: "bg-bad" },
  { key: "cancelled", label: "Cancelled", className: "bg-line-strong" },
]

interface OutcomeColumnsProps {
  days: DayOutcome[]
  /** Names a day, for the readout and the axis. */
  dayLabel: (index: number) => string
}

/**
 * One stacked column per day, outcomes stacked from the bottom, against a
 * count axis. Hovering or tapping a day reads out what finished on it.
 */
export function OutcomeColumns({ days, dayLabel }: OutcomeColumnsProps) {
  const ref = React.useRef<HTMLDivElement>(null)
  const inView = useInView(ref, { once: true, amount: 0.3 })
  const [picked, setPicked] = React.useState<number | null>(null)
  const totalOf = (day: DayOutcome) => day.completed + day.partial + day.failed + day.cancelled
  const busiest = Math.max(1, ...days.map(totalOf))
  const max = Math.max(2, Math.ceil(busiest / 2) * 2)
  const pickedDay = picked === null ? undefined : days[picked]
  const middle = Math.floor((days.length - 1) / 2)

  return (
    <div>
      <Readout hint="Each column is a day. Hover or tap one to see what finished.">
        {picked !== null && pickedDay && (
          <>
            <span className="font-medium text-ink">{dayLabel(picked)}</span>
            <span className="text-ink-2">
              {totalOf(pickedDay) === 0
                ? "nothing finished"
                : OUTCOME_TONES.filter((tone) => pickedDay[tone.key] > 0)
                    .map((tone) => `${pickedDay[tone.key]} ${tone.label.toLowerCase()}`)
                    .join(", ")}
            </span>
          </>
        )}
      </Readout>
      <div className="relative mt-5">
        <span className="pointer-events-none absolute -top-5 left-0 font-mono text-micro text-ink-3">Downloads</span>
        <div className="pointer-events-none absolute left-0 top-0 h-40 w-6 font-mono text-micro text-ink-3 tabular">
          <span className="absolute top-0 -translate-y-1/2">{max}</span>
          <span className="absolute top-1/2 -translate-y-1/2">{max / 2}</span>
          <span className="absolute bottom-0 translate-y-1/2">0</span>
        </div>
        <div
          ref={ref}
          className={cn("relative ml-6 flex h-40 items-end border-b border-line-strong", days.length > 40 ? "gap-px" : "gap-1")}
          onPointerMove={(event) => setPicked(slotAt(event, days.length, "columns"))}
          onPointerDown={(event) => setPicked(slotAt(event, days.length, "columns"))}
          onPointerLeave={(event) => event.pointerType === "mouse" && setPicked(null)}
        >
          <div className="pointer-events-none absolute inset-x-0 top-0 border-t border-dashed border-line" />
          <div className="pointer-events-none absolute inset-x-0 top-1/2 border-t border-dashed border-line" />
          {days.map((day, index) => (
            <motion.div
              key={`${days.length}-${index}`}
              initial={{ scaleY: 0 }}
              animate={inView ? { scaleY: 1 } : undefined}
              transition={{ delay: Math.min(index * 0.012, 0.6), duration: 0.5, ease: EASE_OUT }}
              className={cn(
                "relative flex h-full min-w-0 flex-1 origin-bottom flex-col-reverse rounded-t-[2px] transition-colors",
                picked === index && "bg-sunken",
              )}
            >
              {OUTCOME_TONES.map((tone) =>
                day[tone.key] > 0 ? (
                  <div
                    key={tone.key}
                    className={cn("w-full first:rounded-b-[2px] last:rounded-t-[2px]", tone.className)}
                    style={{ height: `${(day[tone.key] / max) * 100}%` }}
                  />
                ) : null,
              )}
            </motion.div>
          ))}
        </div>
        <div className="ml-6 mt-2 grid grid-cols-3 font-mono text-micro text-ink-3">
          <span>{dayLabel(0)}</span>
          <span className="text-center">{dayLabel(middle)}</span>
          <span className="text-right">{dayLabel(days.length - 1)}</span>
        </div>
      </div>
      <div className="mt-4 flex flex-wrap gap-x-4 gap-y-1.5">
        {OUTCOME_TONES.map((tone) => (
          <span key={tone.key} className="inline-flex items-center gap-1.5 text-[0.8125rem] text-ink-2">
            <span className={cn("size-2.5 rounded-[2px]", tone.className)} />
            {tone.label}
          </span>
        ))}
      </div>
    </div>
  )
}

interface RankBarsProps {
  /** Each row; `id` keys it when labels may repeat or still be loading. */
  items: { id?: string; label: string; count: number }[]
  /** Formats each row's number; plain counts by default. */
  format?: (count: number) => string
}

/** A ranked list where each row's bar is as long as its share of the largest. */
export function RankBars({ items, format = (count) => count.toLocaleString() }: RankBarsProps) {
  const max = Math.max(...items.map((item) => item.count))

  return (
    <ol className="flex flex-col gap-3">
      {items.map((item, index) => (
        <li key={item.id ?? item.label} className="grid grid-cols-[1fr_auto] items-center gap-x-3 gap-y-1">
          <span className="truncate text-sm text-ink">{item.label}</span>
          <span className="font-mono text-[0.8125rem] text-ink-2 tabular">{format(item.count)}</span>
          <motion.span
            initial={{ scaleX: 0 }}
            whileInView={{ scaleX: 1 }}
            viewport={{ once: true }}
            transition={{ delay: staggerDelay(index) * 2, duration: 0.7, ease: EASE_OUT }}
            className={cn("col-span-2 h-1.5 origin-left rounded-full", index === 0 ? "bg-signal" : "bg-ink/15")}
            style={{ width: `${(item.count / max) * 100}%` }}
          />
        </li>
      ))}
    </ol>
  )
}

interface HistogramProps {
  items: { label: string; count: number }[]
  /** The axis caption under the labels. */
  caption: string
  /** The bar picked out in amber. */
  highlight?: number
  /** What the numbers over the bars count, such as "files". */
  countLabel: string
}

/** Vertical bars for a small distribution, one picked out in amber. */
export function Histogram({ items, caption, highlight = 0, countLabel }: HistogramProps) {
  const max = Math.max(1, ...items.map((item) => item.count))

  return (
    <div className="flex flex-1 flex-col">
      <p className="mb-1 font-mono text-micro text-ink-3">{countLabel}</p>
      <div className="flex min-h-44 flex-1 items-end gap-2.5">
        {items.map((item, index) => (
          <div key={item.label} className="flex h-full flex-1 flex-col items-center justify-end gap-1.5">
            <span className="font-mono text-micro text-ink-2 tabular">{item.count}</span>
            <motion.div
              initial={{ scaleY: 0 }}
              whileInView={{ scaleY: 1 }}
              viewport={{ once: true }}
              transition={{ delay: index * 0.06, duration: 0.6, ease: EASE_OUT }}
              className={cn("w-full origin-bottom rounded-t-art rounded-b-[3px]", index === highlight ? "bg-signal" : "bg-ink/10")}
              style={{ height: `${item.count === 0 ? 2 : Math.max(4, (item.count / max) * 100)}%` }}
            />
          </div>
        ))}
      </div>
      <div className="mt-2 flex gap-2.5 border-t border-line pt-2">
        {items.map((item) => (
          <span key={item.label} className="flex-1 text-center font-mono text-[0.8125rem] text-ink">
            {item.label}
          </span>
        ))}
      </div>
      <p className="mt-1 text-center text-micro text-ink-3">{caption}</p>
    </div>
  )
}

/* ------------------------------------------------------------------ */
/* Shares                                                              */
/* ------------------------------------------------------------------ */

/** Ink shades for the parts of a share bar, darkest first. */
const SHARE_TONES = ["bg-ink", "bg-ink-2", "bg-ink-3", "bg-line-strong", "bg-line"]

interface ShareBarProps {
  /** Parts in display order; shares are percentages summing to about 100. */
  parts: { label: string; share: number }[]
  /** Index of a part to pick out in amber. */
  highlight?: number
  size?: "sm" | "md"
}

/** One bar split into parts by share, with a key beneath. */
export function ShareBar({ parts, highlight, size = "sm" }: ShareBarProps) {
  return (
    <div>
      {/* The bar as a whole triggers the parts, since a part scaled to nothing may never count as in view */}
      <motion.div
        initial="hidden"
        whileInView="shown"
        viewport={{ once: true }}
        className={cn("flex overflow-hidden rounded-full", size === "md" ? "h-3" : "h-2")}
      >
        {parts.map((part, index) => (
          <motion.div
            key={part.label}
            variants={{ hidden: { scaleX: 0 }, shown: { scaleX: 1 } }}
            transition={{ delay: index * 0.07, duration: 0.6, ease: EASE_OUT }}
            className={cn("h-full origin-left border-r-2 border-surface last:border-r-0", index === highlight ? "bg-signal" : SHARE_TONES[index])}
            style={{ width: `${part.share}%` }}
          />
        ))}
      </motion.div>
      <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1">
        {parts.map((part, index) => (
          <span key={part.label} className="inline-flex items-center gap-1.5 text-[0.8125rem] text-ink-2">
            <span className={cn("size-2 rounded-full", index === highlight ? "bg-signal" : SHARE_TONES[index])} />
            {part.label}
            <span className="font-mono text-micro text-ink-3 tabular">{part.share}%</span>
          </span>
        ))}
      </div>
    </div>
  )
}
