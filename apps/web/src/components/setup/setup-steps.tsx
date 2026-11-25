import * as React from "react"
import { AnimatePresence, motion } from "motion/react"
import {
  ArrowClockwiseIcon,
  ArrowLeftIcon,
  ArrowRightIcon,
  CheckIcon,
  CheckCircleIcon,
  FilmSlateIcon,
  FolderOpenIcon,
  KeyIcon,
  MagnifyingGlassIcon,
  SparkleIcon,
  TelevisionSimpleIcon,
  TrayArrowDownIcon,
  WarningCircleIcon,
  type Icon,
} from "@phosphor-icons/react"
import { MIN_PASSWORD_LENGTH } from "@findr/types/account"
import type { PathsSettings, SettingsPatch, SettingsResponse } from "@findr/types/settings"
import type { PathStatus, SetupStatus, ToolStatus } from "@findr/types/setup"
import { claimSetup, resetCredentials, updateSettings } from "@/lib/api"
import { signIn, useSession } from "@/lib/auth"
import { EASE_OUT, SPRING_SNAP, staggerDelay } from "@/lib/motion"
import { markSetupPending, stepsDone } from "@/lib/setup"
import { cn } from "@/lib/utils"
import { Button } from "@/components/ui/button"
import { Field, TextInput } from "@/components/ui/field"

/** What every signed-in step receives from the wizard. */
interface StepProps {
  status: SetupStatus
  /** Reads the status and settings again; `true` looks for ffmpeg again too. */
  reload: (refreshTools?: boolean) => Promise<SetupStatus>
  /** Called with the latest status once the step's work is saved. */
  onDone: (status: SetupStatus) => void
  onBack?: () => void
}

/** The message of a failed request. */
function messageOf(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message : fallback
}

// ---------- Shared pieces ---------- //

/** Continue (and Back, when there is one) at the foot of a step. */
function StepActions({ pending, disabled, label = "Continue", onBack }: { pending?: boolean; disabled?: boolean; label?: string; onBack?: () => void }) {
  return (
    <div className="mt-10 flex items-center gap-3">
      <Button type="submit" variant="signal" size="lg" iconEnd={ArrowRightIcon} loading={pending} disabled={disabled}>
        {label}
      </Button>
      {onBack && (
        <Button variant="ghost" size="lg" icon={ArrowLeftIcon} onClick={onBack}>
          Back
        </Button>
      )}
    </div>
  )
}

/** A short status line under a field: done, a warning, or a problem. */
function Note({ tone, children }: { tone: "ok" | "warn" | "bad"; children: React.ReactNode }) {
  const NoteIcon = tone === "ok" ? CheckCircleIcon : WarningCircleIcon
  return (
    <motion.p
      initial={{ opacity: 0, y: -4 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.24, ease: EASE_OUT }}
      role={tone === "ok" ? undefined : "alert"}
      className={cn(
        "flex items-start gap-2 text-[0.8125rem] font-medium leading-relaxed",
        tone === "ok" ? "text-ok" : tone === "warn" ? "text-warn" : "text-bad",
      )}
    >
      <NoteIcon aria-hidden weight="fill" className="mt-0.5 size-4 shrink-0" />
      <span>{children}</span>
    </motion.p>
  )
}

/** A field label with its icon, so each block of a step reads at a glance. */
function Label({ icon: LabelIcon, children }: { icon: Icon; children: React.ReactNode }) {
  return (
    <span className="inline-flex items-center gap-2">
      <LabelIcon aria-hidden weight="duotone" className="size-[1.125rem] text-signal-ink" />
      {children}
    </span>
  )
}

// ---------- Account ---------- //

/**
 * Replaces `admin` / `admin`: signed in as it on the server itself, or from
 * anywhere with the setup code printed in the server's log. Either way the
 * session that follows carries on into the rest of setup.
 */
export function AccountStep({ mode }: { mode: "reset" | "claim" }) {
  const { refetch } = useSession()
  const [code, setCode] = React.useState("")
  const [email, setEmail] = React.useState("")
  const [password, setPassword] = React.useState("")
  const [confirm, setConfirm] = React.useState("")
  const [error, setError] = React.useState<string | null>(null)
  const [pending, setPending] = React.useState(false)
  const mismatch = confirm.length > 0 && confirm !== password

  async function submit(event: React.FormEvent) {
    event.preventDefault()
    if (password !== confirm) return
    setError(null)
    setPending(true)
    try {
      // The rest of setup opens as soon as the app loads
      markSetupPending()
      if (mode === "claim") {
        await claimSetup({ code, email, password })
        const { error: failure } = await signIn.email({ email, password })
        if (failure) throw new Error(failure.message ?? "Your login is saved, but signing in failed. Sign in to carry on.")
      } else {
        await resetCredentials({ email, password })
      }
      // The session now reads without the reset flag, which swaps in the app
      await refetch()
    } catch (failure) {
      setError(messageOf(failure, "Couldn't save your login."))
      setPending(false)
    }
  }

  return (
    <form onSubmit={submit} className="flex flex-col gap-5">
      {mode === "claim" && (
        <Field
          label={<Label icon={KeyIcon}>Setup code</Label>}
          help={
            <>
              Findr prints it when it starts. With Docker, run <code className="font-mono text-ink">docker compose logs findr</code>.
            </>
          }
        >
          {({ id, describedBy }) => (
            <TextInput
              id={id}
              autoFocus
              autoComplete="one-time-code"
              spellCheck={false}
              placeholder="XXXX-XXXX-XXXX"
              aria-describedby={describedBy}
              value={code}
              onChange={(event) => setCode(event.target.value.toUpperCase())}
              className="font-mono tracking-[0.2em]"
              required
            />
          )}
        </Field>
      )}
      <Field label="Email">
        {({ id }) => <TextInput id={id} type="email" autoComplete="username" autoFocus={mode === "reset"} value={email} onChange={(event) => setEmail(event.target.value)} required />}
      </Field>
      <div className="grid gap-5 sm:grid-cols-2">
        <Field label="New password" help={`At least ${MIN_PASSWORD_LENGTH} characters.`}>
          {({ id, describedBy }) => (
            <TextInput id={id} type="password" autoComplete="new-password" minLength={MIN_PASSWORD_LENGTH} aria-describedby={describedBy} value={password} onChange={(event) => setPassword(event.target.value)} required />
          )}
        </Field>
        <Field label="Confirm password" error={mismatch ? "The passwords don't match." : null}>
          {({ id, describedBy, invalid }) => (
            <TextInput id={id} type="password" autoComplete="new-password" aria-describedby={describedBy} aria-invalid={invalid || undefined} value={confirm} onChange={(event) => setConfirm(event.target.value)} required />
          )}
        </Field>
      </div>
      {error && <Note tone="bad">{error}</Note>}
      <StepActions pending={pending} disabled={mismatch} label={mode === "claim" ? "Claim server" : "Save login"} />
    </form>
  )
}

// ---------- Services ---------- //

/**
 * The TMDB key and Prowlarr's address and key. Keys already saved (or found
 * in Prowlarr's own settings, in the Docker stack) are kept unless replaced.
 * An unreachable Prowlarr is pointed out once, then let through, since it may
 * simply not be up yet.
 */
export function ServicesStep({ status, settings, reload, onDone }: StepProps & { settings: SettingsResponse }) {
  const [tmdbKey, setTmdbKey] = React.useState("")
  const [prowlarrUrl, setProwlarrUrl] = React.useState(settings.settings.services.prowlarrUrl)
  const [prowlarrKey, setProwlarrKey] = React.useState("")
  const [error, setError] = React.useState<string | null>(null)
  const [warned, setWarned] = React.useState(false)
  const [pending, setPending] = React.useState(false)
  const { configured } = settings

  async function submit(event: React.FormEvent) {
    event.preventDefault()
    setError(null)
    setPending(true)
    try {
      // Only what was typed is sent, so saved keys stay as they are
      const services: NonNullable<SettingsPatch["services"]> = { prowlarrUrl: prowlarrUrl.trim() }
      if (tmdbKey.trim()) services.tmdbApiKey = tmdbKey.trim()
      if (prowlarrKey.trim()) services.prowlarrApiKey = prowlarrKey.trim()
      await updateSettings({ services })
      const latest = await reload()

      if (!stepsDone(latest).services) {
        setError(!latest.tmdb.configured ? "Add your TMDB API key to carry on." : "Add Prowlarr's address and API key to carry on.")
      } else if (latest.prowlarr.reachable === false && !warned) {
        setWarned(true)
      } else {
        onDone(latest)
        return
      }
    } catch (failure) {
      setError(messageOf(failure, "Couldn't save these settings."))
    }
    setPending(false)
  }

  const savedKey = "Saved. Type a new one to replace it."
  return (
    <form onSubmit={submit} className="flex flex-col gap-6">
      <Field
        label={<Label icon={FilmSlateIcon}>TMDB API key</Label>}
        help={
          <>
            Free from{" "}
            <a href="https://www.themoviedb.org/settings/api" target="_blank" rel="noreferrer" className="font-medium text-ink underline decoration-line-strong underline-offset-2 hover:decoration-ink">
              themoviedb.org
            </a>
            . Use the API key, not the read access token.
          </>
        }
      >
        {({ id, describedBy }) => (
          <TextInput id={id} type="password" autoComplete="off" spellCheck={false} placeholder={configured.tmdbApiKey ? savedKey : undefined} aria-describedby={describedBy} value={tmdbKey} onChange={(event) => setTmdbKey(event.target.value)} className="font-mono" />
        )}
      </Field>

      <div className="flex flex-col gap-4 rounded-panel bg-surface p-5 shadow-ring">
        <Field label={<Label icon={MagnifyingGlassIcon}>Prowlarr address</Label>}>
          {({ id }) => (
            <TextInput id={id} type="url" inputMode="url" spellCheck={false} placeholder="http://localhost:9696" value={prowlarrUrl} onChange={(event) => setProwlarrUrl(event.target.value)} className="font-mono text-[0.8125rem]" />
          )}
        </Field>
        <Field label="Prowlarr API key" help="In Prowlarr under Settings, General, Security.">
          {({ id, describedBy }) => (
            <TextInput id={id} type="password" autoComplete="off" spellCheck={false} placeholder={configured.prowlarrApiKey ? savedKey : undefined} aria-describedby={describedBy} value={prowlarrKey} onChange={(event) => setProwlarrKey(event.target.value)} className="font-mono" />
          )}
        </Field>
        {status.prowlarr.reachable === true && !warned && <Note tone="ok">Prowlarr is answering.</Note>}
        {warned && <Note tone="warn">Prowlarr didn't answer at this address with this key. Check them, or continue and fix it later in Settings.</Note>}
      </div>

      {error && <Note tone="bad">{error}</Note>}
      <StepActions pending={pending} label={warned ? "Continue anyway" : "Continue"} />
    </form>
  )
}

// ---------- Library ---------- //

/** The three folders, in the order a download passes through them. */
const FOLDERS: ReadonlyArray<{ key: keyof PathsSettings; label: string; icon: Icon; help: string; placeholder: string }> = [
  { key: "downloads", label: "Downloads", icon: TrayArrowDownIcon, help: "Scratch space while a release downloads and is cleaned.", placeholder: "/srv/media/downloads" },
  { key: "movies", label: "Movies", icon: FilmSlateIcon, help: "Finished films are filed here.", placeholder: "/srv/media/movies" },
  { key: "series", label: "TV shows", icon: TelevisionSimpleIcon, help: "Finished seasons are filed here.", placeholder: "/srv/media/tv" },
]

/**
 * The downloads folder and the two library folders. Folders that don't exist
 * yet are fine as long as Findr can make them; a folder it can't write to is
 * called out on its own row.
 */
export function LibraryStep({ status, settings, reload, onDone, onBack }: StepProps & { settings: SettingsResponse }) {
  const [paths, setPaths] = React.useState<PathsSettings>(settings.settings.paths)
  const [checked, setChecked] = React.useState<SetupStatus["paths"] | null>(null)
  const [error, setError] = React.useState<string | null>(null)
  const [pending, setPending] = React.useState(false)

  async function submit(event: React.FormEvent) {
    event.preventDefault()
    setError(null)
    setPending(true)
    try {
      await updateSettings({ paths: { downloads: paths.downloads.trim(), movies: paths.movies.trim(), series: paths.series.trim() } })
      const latest = await reload()
      if (stepsDone(latest).library) {
        onDone(latest)
        return
      }
      setChecked(latest.paths)
    } catch (failure) {
      setError(messageOf(failure, "Couldn't save these folders."))
    }
    setPending(false)
  }

  /** What to say under a folder after it has been checked. */
  function problem(path: PathStatus | undefined): string | null {
    if (!path) return null
    if (!path.set) return "Choose a folder."
    if (!path.writable) return "Findr can't write here. Check the folder's owner and permissions."
    return null
  }

  return (
    <form onSubmit={submit} className="flex flex-col gap-5">
      {FOLDERS.map((folder, index) => {
        const issue = problem(checked?.[folder.key])
        const saved = status.paths[folder.key]
        return (
          <motion.div key={folder.key} initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.4, ease: EASE_OUT, delay: staggerDelay(index) * 3 }}>
            <Field label={<Label icon={folder.icon}>{folder.label}</Label>} help={folder.help} error={issue}>
              {({ id, describedBy, invalid }) => (
                <TextInput
                  id={id}
                  spellCheck={false}
                  placeholder={folder.placeholder}
                  aria-describedby={describedBy}
                  aria-invalid={invalid || undefined}
                  value={paths[folder.key]}
                  onChange={(event) => setPaths((current) => ({ ...current, [folder.key]: event.target.value }))}
                  className="font-mono text-[0.8125rem]"
                />
              )}
            </Field>
            {!checked && saved.set && saved.writable && !saved.exists && (
              <p className="mt-2 flex items-center gap-1.5 text-[0.8125rem] text-ink-2">
                <FolderOpenIcon aria-hidden className="size-4" /> Doesn't exist yet. Findr makes it on the first download.
              </p>
            )}
          </motion.div>
        )
      })}
      {error && <Note tone="bad">{error}</Note>}
      <StepActions pending={pending} onBack={onBack} />
    </form>
  )
}

// ---------- Tools ---------- //

/** Where a binary came from, in words. */
function sourceOf(tool: ToolStatus): string {
  switch (tool.source) {
    case "embedded":
      return "Bundled with Findr"
    case "env":
      return `From ${tool.name === "ffmpeg" ? "FFMPEG_PATH" : "FFPROBE_PATH"}`
    case "path":
      return "Installed on this system"
    default:
      return "Not found"
  }
}

/** How long a re-check shows its scanning state at least, so it reads as a check. */
const MIN_SCAN_MS = 900

/**
 * ffmpeg and ffprobe. A compiled Findr carries its own; from source or with
 * an override they come from the system. The paths are deliberately not
 * editable here (a browser shouldn't choose what the server runs), so a
 * missing binary gets instructions and a way to look again.
 */
export function ToolsStep({ status, reload, onDone, onBack }: StepProps) {
  const [scanning, setScanning] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)
  const ready = status.tools.every((tool) => tool.path !== null)

  async function rescan() {
    setError(null)
    setScanning(true)
    try {
      await Promise.all([reload(true), new Promise((resolve) => setTimeout(resolve, MIN_SCAN_MS))])
    } catch (failure) {
      setError(messageOf(failure, "Couldn't check again."))
    }
    setScanning(false)
  }

  return (
    <form
      onSubmit={(event) => {
        event.preventDefault()
        if (ready) onDone(status)
      }}
      className="flex flex-col gap-5"
    >
      <ul className="relative flex flex-col overflow-hidden rounded-panel bg-surface shadow-ring">
        {/* A sweep across the rows while Findr looks again */}
        <AnimatePresence>
          {scanning && (
            <motion.span
              aria-hidden
              className="pointer-events-none absolute inset-y-0 w-1/3 bg-[linear-gradient(90deg,transparent,var(--color-signal-soft),transparent)]"
              initial={{ x: "-100%" }}
              animate={{ x: "300%" }}
              exit={{ opacity: 0 }}
              transition={{ duration: 0.9, ease: "easeInOut", repeat: Infinity }}
            />
          )}
        </AnimatePresence>
        {status.tools.map((tool, index) => {
          const found = tool.path !== null
          return (
            <li key={tool.name} className={cn("relative flex items-center gap-4 px-5 py-4", index > 0 && "border-t border-line")}>
              <span className={cn("grid size-10 shrink-0 place-items-center rounded-full transition-colors", found ? "bg-ok-soft text-ok" : "bg-bad-soft text-bad")}>
                <AnimatePresence mode="popLayout" initial={false}>
                  <motion.span key={found ? "ok" : "missing"} initial={{ scale: 0.3, opacity: 0 }} animate={{ scale: 1, opacity: 1 }} exit={{ scale: 0.3, opacity: 0 }} transition={SPRING_SNAP}>
                    {found ? <CheckIcon aria-hidden weight="bold" className="size-5" /> : <WarningCircleIcon aria-hidden weight="bold" className="size-5" />}
                  </motion.span>
                </AnimatePresence>
              </span>
              <div className="min-w-0 flex-1">
                <p className="flex items-baseline gap-2 text-sm font-semibold text-ink">
                  <span className="font-mono">{tool.name}</span>
                  {tool.version && <span className="font-mono text-[0.75rem] font-normal text-ink-3">{tool.version}</span>}
                </p>
                <p className="truncate text-[0.8125rem] text-ink-2" title={tool.path ?? undefined}>
                  {sourceOf(tool)}
                </p>
              </div>
            </li>
          )
        })}
      </ul>

      {!ready && (
        <div className="rounded-panel bg-warn-soft p-5 text-[0.875rem] leading-relaxed text-ink">
          <p className="font-semibold">ffmpeg is needed to clean downloads and play them.</p>
          <p className="mt-1 text-ink-2">
            Install ffmpeg on the server (it comes with ffprobe), or set <code className="font-mono text-ink">FFMPEG_PATH</code> and{" "}
            <code className="font-mono text-ink">FFPROBE_PATH</code> and restart Findr. Then check again.
          </p>
        </div>
      )}
      {error && <Note tone="bad">{error}</Note>}

      <div className="mt-5 flex flex-wrap items-center gap-3">
        <Button type="submit" variant="signal" size="lg" iconEnd={ArrowRightIcon} disabled={!ready || scanning}>
          Continue
        </Button>
        <Button variant="outline" size="lg" icon={ArrowClockwiseIcon} loading={scanning} onClick={rescan}>
          Check again
        </Button>
        {onBack && (
          <Button variant="ghost" size="lg" icon={ArrowLeftIcon} onClick={onBack}>
            Back
          </Button>
        )}
      </div>
    </form>
  )
}

// ---------- Done ---------- //

/** The end of setup: a moment of arrival, then into the app. */
export function DoneStep({ onFinish }: { onFinish?: () => void }) {
  return (
    <div className="flex flex-col items-start gap-8">
      <motion.span
        initial={{ scale: 0.4, rotate: -24, opacity: 0 }}
        animate={{ scale: 1, rotate: 0, opacity: 1 }}
        transition={{ ...SPRING_SNAP, delay: 0.12 }}
        className="relative grid size-20 place-items-center rounded-full bg-signal text-ink shadow-lift"
      >
        <CheckIcon aria-hidden weight="bold" className="size-9" />
        <motion.span
          aria-hidden
          initial={{ scale: 0.6, opacity: 0, rotate: -40 }}
          animate={{ scale: 1, opacity: 1, rotate: 0 }}
          transition={{ ...SPRING_SNAP, delay: 0.32 }}
          className="absolute -right-2 -top-2 grid size-8 place-items-center rounded-full bg-surface text-signal-ink shadow-ring"
        >
          <SparkleIcon weight="fill" className="size-4" />
        </motion.span>
      </motion.span>
      <Button variant="signal" size="lg" iconEnd={ArrowRightIcon} onClick={onFinish} autoFocus>
        Open Findr
      </Button>
    </div>
  )
}
