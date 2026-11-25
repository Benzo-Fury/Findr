import { SetupWizard } from "@/components/setup/setup-wizard"

/**
 * The initial admin's first screen. A fresh install signs in as `admin` /
 * `admin`; until that account sets its own email and password the server
 * refuses everything else, so setup's account step replaces the whole app.
 * The rest of setup carries on over the app once it loads.
 */
export function CredentialsPage() {
  return <SetupWizard account="reset" />
}
