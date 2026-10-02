import * as React from "react"
import { AnimatePresence, motion } from "motion/react"
import { CheckCircleIcon, WarningCircleIcon, XIcon } from "@phosphor-icons/react"
import { SPRING_PANEL } from "@/lib/motion"
import { cn } from "@/lib/utils"

/** A short-lived confirmation or failure notice. */
export interface ToastInput {
  title: string
  description?: string
  tone?: "ok" | "bad"
  /** One follow-up, such as "View" after starting a download. */
  action?: { label: string; onClick: () => void }
}

interface ToastEntry extends ToastInput {
  id: number
}

const ToastContext = React.createContext<((toast: ToastInput) => void) | null>(null)

/** How long a toast stays before it leaves on its own. */
const TOAST_MS = 5200

/**
 * Hosts toasts at the bottom of the screen, above the phone tab bar. They are
 * announced politely to screen readers and pause while hovered.
 */
export function ToastProvider({ children }: { children: React.ReactNode }) {
  const [toasts, setToasts] = React.useState<ToastEntry[]>([])
  const nextId = React.useRef(0)

  const dismiss = React.useCallback((id: number) => setToasts((current) => current.filter((toast) => toast.id !== id)), [])

  const push = React.useCallback((toast: ToastInput) => {
    const id = nextId.current++
    // Keep at most three; the oldest gives way
    setToasts((current) => [...current.slice(-2), { ...toast, id }])
  }, [])

  return (
    <ToastContext.Provider value={push}>
      {children}
      <div
        aria-live="polite"
        className="pointer-events-none fixed inset-x-0 bottom-[calc(var(--tabs-height)+env(safe-area-inset-bottom)+0.75rem)] z-[var(--z-toast)] flex flex-col items-center gap-2 px-4 md:bottom-6"
      >
        <AnimatePresence initial={false}>
          {toasts.map((toast) => (
            <ToastCard key={toast.id} toast={toast} onDismiss={dismiss} />
          ))}
        </AnimatePresence>
      </div>
    </ToastContext.Provider>
  )
}

/** Shows a toast. Must be used beneath `ToastProvider`. */
export function useToast(): (toast: ToastInput) => void {
  const push = React.useContext(ToastContext)
  if (!push) throw new Error("useToast must be used inside ToastProvider")
  return push
}

interface ToastCardProps {
  toast: ToastEntry
  onDismiss: (id: number) => void
}

function ToastCard({ toast, onDismiss }: ToastCardProps) {
  const [paused, setPaused] = React.useState(false)
  const ToneIcon = toast.tone === "bad" ? WarningCircleIcon : CheckCircleIcon
  const close = () => onDismiss(toast.id)

  // The timer restarts after a hover, so a toast is never pulled away mid-read
  React.useEffect(() => {
    if (paused) return
    const timer = setTimeout(() => onDismiss(toast.id), TOAST_MS)
    return () => clearTimeout(timer)
  }, [paused, onDismiss, toast.id])

  return (
    <motion.div
      layout
      initial={{ opacity: 0, y: 24, scale: 0.96 }}
      animate={{ opacity: 1, y: 0, scale: 1 }}
      exit={{ opacity: 0, y: 12, scale: 0.96 }}
      transition={SPRING_PANEL}
      onPointerEnter={() => setPaused(true)}
      onPointerLeave={() => setPaused(false)}
      role="status"
      className="pointer-events-auto flex w-full max-w-md items-center gap-3 rounded-panel bg-ink py-2.5 pl-4 pr-2 text-surface shadow-float"
    >
      <ToneIcon aria-hidden weight="fill" className={cn("size-5 shrink-0", toast.tone === "bad" ? "text-[oklch(0.75_0.15_27)]" : "text-signal")} />
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm font-medium">{toast.title}</p>
        {toast.description && <p className="truncate text-[0.8125rem] text-surface/70">{toast.description}</p>}
      </div>
      {toast.action && (
        <button
          type="button"
          onClick={() => {
            toast.action?.onClick()
            close()
          }}
          className="h-8 shrink-0 rounded-full bg-surface/12 px-3 text-[0.8125rem] font-medium transition-colors hover:bg-surface/20"
        >
          {toast.action.label}
        </button>
      )}
      <button
        type="button"
        aria-label="Dismiss"
        onClick={close}
        className="flex size-8 shrink-0 items-center justify-center rounded-full text-surface/70 transition-colors hover:bg-surface/12 hover:text-surface"
      >
        <XIcon weight="bold" className="size-4" />
      </button>
    </motion.div>
  )
}
