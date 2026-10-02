import * as React from "react"
import { Dialog } from "@base-ui/react/dialog"
import { AnimatePresence, motion, useDragControls, type PanInfo } from "motion/react"
import { XIcon } from "@phosphor-icons/react"
import { FADE, SPRING_PANEL } from "@/lib/motion"
import { useIsPhone } from "@/lib/responsive"
import { cn } from "@/lib/utils"

interface SheetProps {
  open: boolean
  onClose: () => void
  /** Accessible title for the dialog. */
  label: string
  children: React.ReactNode
  /** Width on tablets and desktops. */
  width?: "md" | "lg"
  /** Element focused on open; the dialog itself by default. */
  initialFocus?: React.RefObject<HTMLElement | null>
}

/** Drag distance or speed past which a bottom sheet closes. */
const DISMISS_OFFSET = 140
const DISMISS_VELOCITY = 650

const WIDTHS = {
  md: "md:w-[min(34rem,calc(100vw-1rem))]",
  lg: "md:w-[min(44rem,calc(100vw-1rem))]",
} as const

/**
 * A modal panel for detail views. On tablets and desktops it floats in from
 * the right, leaving the page visible behind it; on phones it rises from the
 * bottom and can be dragged down to close. Focus is trapped, Escape closes,
 * and the page behind does not scroll.
 */
export function Sheet({ open, onClose, label, children, width = "lg", initialFocus }: SheetProps) {
  const phone = useIsPhone()
  const drag = useDragControls()

  function onDragEnd(_: PointerEvent, info: PanInfo) {
    if (info.offset.y > DISMISS_OFFSET || info.velocity.y > DISMISS_VELOCITY) onClose()
  }

  return (
    <Dialog.Root open={open} onOpenChange={(next) => !next && onClose()}>
      <AnimatePresence>
        {open && (
          <Dialog.Portal keepMounted>
            <Dialog.Backdrop
              render={<motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={FADE} />}
              className="fixed inset-0 z-[var(--z-overlay)] bg-veil"
            />
            <Dialog.Popup
              initialFocus={initialFocus}
              render={
                phone ? (
                  <motion.div
                    initial={{ y: "100%", opacity: 0.999 }}
                    animate={{ y: 0, opacity: 1 }}
                    exit={{ y: "100%", opacity: 0.999 }}
                    transition={SPRING_PANEL}
                    drag="y"
                    dragListener={false}
                    dragControls={drag}
                    dragConstraints={{ top: 0, bottom: 0 }}
                    dragElastic={{ top: 0, bottom: 0.7 }}
                    onDragEnd={onDragEnd}
                  />
                ) : (
                  <motion.div
                    initial={{ x: 56, opacity: 0 }}
                    animate={{ x: 0, opacity: 1 }}
                    exit={{ x: 40, opacity: 0 }}
                    transition={SPRING_PANEL}
                  />
                )
              }
              className={cn(
                "fixed z-[var(--z-overlay)] flex flex-col overflow-hidden bg-surface shadow-float outline-none",
                "inset-x-0 bottom-0 h-[94dvh] rounded-t-panel",
                "md:inset-x-auto md:inset-y-2 md:right-2 md:h-auto md:rounded-panel",
                WIDTHS[width],
              )}
            >
              <Dialog.Title className="sr-only">{label}</Dialog.Title>
              {phone && (
                <div
                  onPointerDown={(event) => drag.start(event)}
                  className="absolute inset-x-0 top-0 z-[2] flex h-6 touch-none justify-center pt-2"
                >
                  <span aria-hidden className="h-1.5 w-11 rounded-full bg-ink/20" />
                </div>
              )}
              <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain">{children}</div>
            </Dialog.Popup>
          </Dialog.Portal>
        )}
      </AnimatePresence>
    </Dialog.Root>
  )
}

interface SheetCloseProps {
  className?: string
  /** `overlay` sits on artwork; `plain` sits on the panel. */
  tone?: "overlay" | "plain"
}

/** The sheet's close button. */
export function SheetClose({ className, tone = "plain" }: SheetCloseProps) {
  return (
    <Dialog.Close
      aria-label="Close"
      className={cn(
        "flex size-10 items-center justify-center rounded-full transition-[transform,background-color] duration-200 active:scale-90",
        tone === "overlay"
          ? "bg-surface/85 text-ink shadow-lift backdrop-blur-md hover:bg-surface"
          : "text-ink-2 hover:bg-sunken hover:text-ink",
        className,
      )}
    >
      <XIcon weight="bold" className="size-[1.125rem]" />
    </Dialog.Close>
  )
}
