import * as React from "react"
import { Dialog } from "@base-ui/react/dialog"
import { motion } from "motion/react"
import type { SetupStatus } from "@findr/types/setup"
import { fetchSetupStatus } from "@/lib/api"
import { isAdmin, type Session } from "@/lib/auth"
import { EASE_OUT } from "@/lib/motion"
import { clearSetupPending, setupPending } from "@/lib/setup"
import { SetupWizard } from "@/components/setup/setup-wizard"

/**
 * Opens first-run setup over the app for an admin while anything downloads
 * need is missing. It can't be dismissed until then: without those settings
 * no download could work. Other accounts never see it.
 *
 * Right after the account step it opens at once (`setupPending`); otherwise
 * it opens only once the server says setup is incomplete, so an install that
 * is already set up never flashes it.
 */
export function SetupGate({ session }: { session: Session }) {
  const admin = isAdmin(session)
  const [open, setOpen] = React.useState(() => admin && setupPending())
  const [status, setStatus] = React.useState<SetupStatus | undefined>()

  React.useEffect(() => {
    if (!admin) return
    fetchSetupStatus()
      .then((loaded) => {
        setStatus(loaded)
        setOpen(!loaded.complete)
        if (loaded.complete) clearSetupPending()
      })
      .catch(() => {})
  }, [admin])

  function finish() {
    clearSetupPending()
    setOpen(false)
  }

  return (
    <Dialog.Root open={open} onOpenChange={() => {}} modal>
      {open && (
        <Dialog.Portal>
          <Dialog.Popup
            aria-label="Set up Findr"
            render={<motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ duration: 0.4, ease: EASE_OUT }} />}
            className="fixed inset-0 z-[var(--z-overlay)] overflow-y-auto bg-paper outline-none"
          >
            <SetupWizard initialStatus={status} onFinish={finish} />
          </Dialog.Popup>
        </Dialog.Portal>
      )}
    </Dialog.Root>
  )
}
