import * as React from "react"
import { AnimatePresence, motion } from "motion/react"
import { CheckIcon, FolderSimpleIcon, PlugsConnectedIcon, SignOutIcon, UserCircleIcon, WrenchIcon, type Icon } from "@phosphor-icons/react"
import type { SettingsResponse } from "@findr/types/settings"
import type { SetupStatus } from "@findr/types/setup"
import { fetchSettings, fetchSetupStatus } from "@/lib/api"
import { signOut } from "@/lib/auth"
import { firstOpenStep, stepsDone, type StepId } from "@/lib/setup"
import { EASE_OUT, SPRING_PANEL, SPRING_SNAP } from "@/lib/motion"
import { cn } from "@/lib/utils"
import { Brand } from "@/components/shell/brand"
import { Button } from "@/components/ui/button"
import { Skeleton } from "@/components/ui/skeleton"
import { AccountStep, DoneStep, LibraryStep, ServicesStep, ToolsStep } from "@/components/setup/setup-steps"

/** The steps the rail lists; `done` is where they lead. */
const STEPS: ReadonlyArray<{ id: Exclude<StepId, "done">; label: string; icon: Icon }> = [
  { id: "account", label: "Your login", icon: UserCircleIcon },
  { id: "services", label: "Services", icon: PlugsConnectedIcon },
  { id: "library", label: "Library folders", icon: FolderSimpleIcon },
  { id: "tools", label: "ffmpeg", icon: WrenchIcon },
]

/** Each step's heading and the line under it. */
const COPY: Record<StepId, { title: string; description: string }> = {
  account: { title: "Make it yours", description: "Replace the default admin login with your own email and password." },
  services: { title: "Connect your services", description: "Findr looks titles up on TMDB and searches for releases through Prowlarr." },
  library: { title: "Pick your folders", description: "Where downloads are worked on, and where finished films and shows are filed." },
  tools: { title: "Check the tools", description: "Findr cleans every download and plays your library with ffmpeg." },
  done: { title: "You're set", description: "Search for a film or a show, and Findr takes it from there." },
}

/** The account step's heading when the server is claimed from another machine. */
const CLAIM_COPY = { title: "Claim this server", description: "Enter the setup code from Findr's log, then choose your own email and password." }

interface SetupWizardProps {
  /**
   * Before anyone is signed in: the account step, either replacing `admin` /
   * `admin` or claiming the server with its setup code. The later steps are
   * shown but wait for the account.
   */
  account?: "reset" | "claim"
  /** A status already fetched, so the first paint is right. */
  initialStatus?: SetupStatus
  /** Leaves the wizard once everything is in place. */
  onFinish?: () => void
}

/**
 * First-run setup, as a full-screen guided flow. A rail on the left (a strip
 * across the top on phones) lists every step and fills in as each is done;
 * the current step slides in on the right. Steps can't be skipped while
 * something downloads need is missing, but any finished step can be revisited
 * from the rail.
 */
export function SetupWizard({ account, initialStatus, onFinish }: SetupWizardProps) {
  const [status, setStatus] = React.useState<SetupStatus | null>(initialStatus ?? null)
  const [settings, setSettings] = React.useState<SettingsResponse | null>(null)
  const [step, setStep] = React.useState<StepId>(account ? "account" : initialStatus ? firstOpenStep(initialStatus) : "services")
  const [direction, setDirection] = React.useState(1)
  const [loadError, setLoadError] = React.useState<string | null>(null)

  // Signed in, the status and current settings fill the steps
  const load = React.useCallback(async (refreshTools = false) => {
    const [nextStatus, nextSettings] = await Promise.all([fetchSetupStatus(refreshTools), fetchSettings()])
    setStatus(nextStatus)
    setSettings(nextSettings)
    return nextStatus
  }, [])

  React.useEffect(() => {
    if (account) return
    load()
      .then((loaded) => {
        if (!initialStatus) setStep(firstOpenStep(loaded))
      })
      .catch((error: unknown) => setLoadError(error instanceof Error ? error.message : "Couldn't read the server's setup."))
  }, [account, initialStatus, load])

  const done = status ? stepsDone(status) : null
  const order: StepId[] = [...STEPS.map((entry) => entry.id), "done"]
  const isDone = (id: StepId) => (id === "account" ? !account : Boolean(done?.[id as keyof typeof done]))

  /** Moves to a step, sliding the right way. */
  function go(next: StepId) {
    setDirection(order.indexOf(next) >= order.indexOf(step) ? 1 : -1)
    setStep(next)
  }

  /** After a step saves: the next one that still needs something, or the one after this. */
  function advance(latest: SetupStatus | null) {
    if (!latest) return
    const open = firstOpenStep(latest)
    const after = order[order.indexOf(step) + 1] ?? "done"
    go(order.indexOf(open) > order.indexOf(step) ? open : after)
  }

  const copy = step === "account" && account === "claim" ? CLAIM_COPY : COPY[step]
  const ready = Boolean(account) || (status && settings)

  return (
    <div className="grid min-h-[100dvh] bg-paper lg:grid-cols-[22rem_minmax(0,1fr)]">
      {/* The rail: every step, filling in as it's done */}
      <aside className="relative border-line max-lg:border-b lg:border-r lg:bg-surface/60">
        <div className="flex h-full flex-col gap-6 px-5 py-5 sm:px-8 lg:px-8 lg:py-10">
          <Brand />
          <nav aria-label="Setup steps" className="relative">
            {/* The track behind the icons, inked in up to the current step */}
            <div aria-hidden className="absolute left-[1.1875rem] top-5 bottom-5 w-px bg-line max-lg:hidden">
              <motion.div
                className="absolute inset-x-0 top-0 h-full origin-top bg-ink"
                initial={false}
                animate={{ scaleY: step === "done" ? 1 : Math.min(order.indexOf(step) / (STEPS.length - 1), 1) }}
                transition={SPRING_PANEL}
              />
            </div>
            <ol className="flex gap-1 overflow-x-auto max-lg:-mx-1 lg:flex-col lg:gap-2">
              {STEPS.map((entry) => {
                const current = step === entry.id
                const complete = isDone(entry.id)
                const reachable = !account && entry.id !== "account" && (complete || current || order.indexOf(entry.id) <= order.indexOf(firstOpenOf(status)))
                const StepIcon = entry.icon
                return (
                  <li key={entry.id} className="relative shrink-0">
                    {current && (
                      <motion.span layoutId="setup-rail-current" transition={SPRING_SNAP} className="absolute inset-0 rounded-full bg-signal-soft shadow-ring" />
                    )}
                    <button
                      type="button"
                      disabled={!reachable || current}
                      aria-current={current ? "step" : undefined}
                      onClick={() => go(entry.id)}
                      className={cn(
                        "relative flex items-center gap-3 rounded-full py-1.5 pl-1.5 pr-4 text-left text-sm transition-colors",
                        "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ink",
                        current ? "font-semibold text-ink" : complete ? "text-ink-2 hover:text-ink" : "text-ink-3",
                        reachable && !current && "hover:bg-sunken",
                      )}
                    >
                      <span
                        className={cn(
                          "relative grid size-8 shrink-0 place-items-center rounded-full transition-colors",
                          complete ? "bg-ink text-surface" : current ? "bg-surface text-ink shadow-ring" : "bg-sunken text-ink-3",
                        )}
                      >
                        <AnimatePresence initial={false} mode="popLayout">
                          {complete ? (
                            <motion.span key="done" initial={{ scale: 0.4, rotate: -30, opacity: 0 }} animate={{ scale: 1, rotate: 0, opacity: 1 }} exit={{ scale: 0.4, opacity: 0 }} transition={SPRING_SNAP}>
                              <CheckIcon aria-hidden weight="bold" className="size-4" />
                            </motion.span>
                          ) : (
                            <motion.span key="icon" initial={{ scale: 0.6, opacity: 0 }} animate={{ scale: 1, opacity: 1 }} exit={{ scale: 0.6, opacity: 0 }} transition={SPRING_SNAP}>
                              <StepIcon aria-hidden weight={current ? "fill" : "regular"} className="size-[1.0625rem]" />
                            </motion.span>
                          )}
                        </AnimatePresence>
                      </span>
                      <span className="whitespace-nowrap">{entry.label}</span>
                      <span className="sr-only">{complete ? "(done)" : current ? "(current)" : ""}</span>
                    </button>
                  </li>
                )
              })}
            </ol>
          </nav>
          <div className="mt-auto flex flex-col items-start gap-3 max-lg:hidden">
            <p className="text-[0.8125rem] leading-relaxed text-ink-3">Everything here can be changed later under Settings.</p>
            {account === "reset" && (
              <Button variant="ghost" size="sm" icon={SignOutIcon} onClick={() => signOut()} className="-ml-3">
                Sign out
              </Button>
            )}
          </div>
        </div>
      </aside>

      {/* The current step */}
      <main className="flex min-w-0 items-start px-5 py-10 sm:px-10 lg:items-center lg:px-16 lg:py-14">
        <div className="w-full max-w-xl">
          <AnimatePresence mode="wait" custom={direction} initial={false}>
            <motion.section
              key={step}
              custom={direction}
              variants={{
                enter: (dir: number) => ({ opacity: 0, x: dir * 40, filter: "blur(6px)" }),
                center: { opacity: 1, x: 0, filter: "blur(0px)" },
                exit: (dir: number) => ({ opacity: 0, x: dir * -28, filter: "blur(4px)" }),
              }}
              initial="enter"
              animate="center"
              exit="exit"
              transition={{ x: SPRING_PANEL, opacity: { duration: 0.24, ease: EASE_OUT }, filter: { duration: 0.24, ease: EASE_OUT } }}
              aria-labelledby="setup-step-title"
            >
              <h1 id="setup-step-title" className="display text-5xl text-ink sm:text-6xl">
                {copy.title}
              </h1>
              <p className="mt-3 max-w-[52ch] text-[0.9375rem] leading-relaxed text-ink-2">{copy.description}</p>

              <div className="mt-9">
                {loadError ? (
                  <p role="alert" className="text-sm font-medium text-bad">{loadError}</p>
                ) : !ready ? (
                  <div className="flex flex-col gap-4">
                    <Skeleton className="h-11 w-full rounded-full" />
                    <Skeleton className="h-11 w-full rounded-full" />
                    <Skeleton className="h-11 w-2/3 rounded-full" />
                  </div>
                ) : step === "account" ? (
                  <AccountStep mode={account ?? "reset"} />
                ) : step === "services" ? (
                  <ServicesStep status={status!} settings={settings!} reload={load} onDone={advance} />
                ) : step === "library" ? (
                  <LibraryStep status={status!} settings={settings!} reload={load} onDone={advance} onBack={() => go("services")} />
                ) : step === "tools" ? (
                  <ToolsStep status={status!} reload={load} onDone={advance} onBack={() => go("library")} />
                ) : (
                  <DoneStep onFinish={onFinish} />
                )}
              </div>
            </motion.section>
          </AnimatePresence>
        </div>
      </main>
    </div>
  )
}

/** The furthest step that may be opened: the first one still needing something. */
function firstOpenOf(status: SetupStatus | null): StepId {
  return status ? firstOpenStep(status) : "services"
}
