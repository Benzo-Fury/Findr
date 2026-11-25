import * as React from "react"
import { AnimatePresence, motion } from "motion/react"
import { CaretDownIcon, CheckCircleIcon, CheckIcon, CopyIcon, GaugeIcon, InfoIcon, WarningCircleIcon, type Icon } from "@phosphor-icons/react"
import type { DiagnosticLevel, PlaybackDiagnostic, PlaybackDiagnostics } from "@findr/types/playback"
import { fetchPlaybackDiagnostics } from "@/lib/api"
import { FADE } from "@/lib/motion"
import { cn } from "@/lib/utils"
import { Button } from "@/components/ui/button"
import { Skeleton } from "@/components/ui/skeleton"

/** How each level is drawn and named. */
export const LEVELS: Record<DiagnosticLevel, { label: string; icon: Icon; tone: string }> = {
  problem: { label: "Needs fixing", icon: WarningCircleIcon, tone: "text-bad" },
  slower: { label: "Could be faster", icon: GaugeIcon, tone: "text-warn" },
  note: { label: "Good to know", icon: InfoIcon, tone: "text-ink-3" },
}

/**
 * What stops this machine playing as well as it could, worst first, each
 * opening to what to do about it. Reloads when `revision` changes, as after
 * the hardware is tested again.
 */
export function PlaybackChecks({ revision }: { revision: number }) {
  const [result, setResult] = React.useState<PlaybackDiagnostics | null>(null)
  const [error, setError] = React.useState<string | null>(null)

  React.useEffect(() => {
    const controller = new AbortController()
    fetchPlaybackDiagnostics({ signal: controller.signal })
      .then((next) => {
        setResult(next)
        setError(null)
      })
      .catch((reason: unknown) => {
        if (!controller.signal.aborted) setError(reason instanceof Error ? reason.message : "The checks could not run")
      })
    return () => controller.abort()
  }, [revision])

  const counts = result ? countLevels(result.items) : null
  return (
    <div className="rounded-panel bg-sunken px-4 py-3.5">
      <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
        <p className="text-micro font-semibold text-ink-3">How well this machine plays</p>
        {counts && result && result.items.length > 0 && (
          <p className="text-micro text-ink-3 tabular">
            {(Object.keys(LEVELS) as DiagnosticLevel[])
              .filter((level) => counts[level] > 0)
              .map((level) => `${counts[level]} ${LEVELS[level].label.toLowerCase()}`)
              .join(" · ")}
          </p>
        )}
      </div>
      {error ? (
        <p className="mt-1 text-[0.8125rem] text-ink-2">{error}</p>
      ) : result === null ? (
        <div className="mt-2 space-y-2">
          <Skeleton className="h-10 rounded-[0.75rem]" />
          <Skeleton className="h-10 rounded-[0.75rem]" />
        </div>
      ) : result.items.length === 0 ? (
        <p className="mt-1 flex items-center gap-1.5 text-[0.8125rem] text-ok">
          <CheckCircleIcon aria-hidden weight="bold" className="size-4 shrink-0" />
          Nothing to improve: everything a conversion can run on the hardware does.
        </p>
      ) : (
        <ul className="mt-2 divide-y divide-line">
          {result.items.map((item) => (
            <CheckRow key={item.id} item={item} />
          ))}
        </ul>
      )}
    </div>
  )
}

/** One finding: its level, what's wrong and why, opening to the fix. */
function CheckRow({ item }: { item: PlaybackDiagnostic }) {
  const [open, setOpen] = React.useState(item.level === "problem")
  const level = LEVELS[item.level]
  const LevelIcon = level.icon
  const fixable = item.fix !== null || item.snippet !== null
  const panelId = React.useId()

  return (
    <li className="py-2.5">
      <button
        type="button"
        onClick={() => fixable && setOpen((current) => !current)}
        aria-expanded={fixable ? open : undefined}
        aria-controls={fixable ? panelId : undefined}
        className={cn("group flex w-full items-start gap-2.5 text-left", fixable ? "cursor-pointer" : "cursor-default")}
      >
        <LevelIcon aria-label={level.label} weight="bold" className={cn("mt-0.5 size-4 shrink-0", level.tone)} />
        <span className="min-w-0 flex-1">
          <span className="block text-[0.875rem] font-semibold text-ink">{item.title}</span>
          <span className="mt-0.5 block text-[0.8125rem] leading-relaxed text-ink-2 [overflow-wrap:anywhere]">{withCode(item.detail)}</span>
        </span>
        {fixable && (
          <CaretDownIcon aria-hidden weight="bold" className={cn("mt-1 size-3.5 shrink-0 text-ink-3 transition-transform group-hover:text-ink", open && "rotate-180")} />
        )}
      </button>
      <AnimatePresence initial={false}>
        {fixable && open && (
          <motion.div id={panelId} initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: "auto" }} exit={{ opacity: 0, height: 0 }} transition={FADE} className="overflow-hidden">
            <div className="ml-[1.625rem] pt-2">
              {item.fix && <p className="text-[0.8125rem] leading-relaxed text-ink [overflow-wrap:anywhere]">{withCode(item.fix)}</p>}
              {item.snippet && <Snippet text={item.snippet} />}
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </li>
  )
}

/** Configuration to copy into compose.yml, or a command to run. */
function Snippet({ text }: { text: string }) {
  const [copied, setCopied] = React.useState(false)

  async function copy() {
    try {
      await navigator.clipboard.writeText(text)
      setCopied(true)
      window.setTimeout(() => setCopied(false), 2000)
    } catch {
      // Clipboard refused (an insecure origin); the text can still be selected by hand
    }
  }

  return (
    <div className="mt-2 rounded-[0.75rem] bg-surface p-2 shadow-ring">
      <pre className="overflow-x-auto px-1.5 py-1 font-mono text-micro leading-relaxed text-ink">{text}</pre>
      <Button variant="ghost" size="sm" icon={copied ? CheckIcon : CopyIcon} onClick={() => void copy()} className="mt-1">
        {copied ? "Copied" : "Copy"}
      </Button>
    </div>
  )
}

/** Findings per level. */
function countLevels(items: PlaybackDiagnostic[]): Record<DiagnosticLevel, number> {
  const counts: Record<DiagnosticLevel, number> = { problem: 0, slower: 0, note: 0 }
  for (const item of items) counts[item.level]++
  return counts
}

/** Text with `backticked` paths and names set as code. */
export function withCode(text: string): React.ReactNode {
  return text.split(/(`[^`]+`)/).map((part, index) =>
    part.startsWith("`") && part.endsWith("`") && part.length > 2 ? (
      <code key={index} className="font-mono text-[0.75rem] text-ink">
        {part.slice(1, -1)}
      </code>
    ) : (
      <React.Fragment key={index}>{part}</React.Fragment>
    ),
  )
}
