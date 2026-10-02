import * as React from "react"
import { CheckIcon } from "@phosphor-icons/react"
import { MIN_PASSWORD_LENGTH } from "@findr/types/account"
import { resetCredentials } from "@/lib/api"
import { signOut, useSession } from "@/lib/auth"
import { Button } from "@/components/ui/button"
import { Field, TextInput } from "@/components/ui/field"
import { AuthShell } from "@/components/shell/auth-shell"

/**
 * The initial admin's first screen. A fresh install signs in as `admin` /
 * `admin`; until that account sets its own email and password the server
 * refuses everything else, so this replaces the whole app.
 */
export function CredentialsPage() {
  const { refetch } = useSession()
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
      await resetCredentials({ email, password })
      // The session now reads without the reset flag, which swaps in the app
      await refetch()
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not save your credentials.")
      setPending(false)
    }
  }

  return (
    <AuthShell title="Make it yours" description="Replace the default admin login with your own email and password before anything else.">
      <form onSubmit={submit} className="flex flex-col gap-5">
        <Field label="Email">
          {({ id }) => <TextInput id={id} type="email" autoComplete="username" autoFocus value={email} onChange={(event) => setEmail(event.target.value)} required />}
        </Field>
        <Field label="New password" help={`At least ${MIN_PASSWORD_LENGTH} characters.`}>
          {({ id, describedBy }) => (
            <TextInput id={id} type="password" autoComplete="new-password" minLength={MIN_PASSWORD_LENGTH} aria-describedby={describedBy} value={password} onChange={(event) => setPassword(event.target.value)} required />
          )}
        </Field>
        <Field label="Confirm password" error={mismatch ? "The passwords do not match." : error}>
          {({ id, describedBy, invalid }) => (
            <TextInput id={id} type="password" autoComplete="new-password" aria-describedby={describedBy} aria-invalid={invalid || undefined} value={confirm} onChange={(event) => setConfirm(event.target.value)} required />
          )}
        </Field>
        <Button type="submit" variant="signal" size="lg" icon={CheckIcon} loading={pending} disabled={mismatch} className="mt-2 w-full">
          Save and continue
        </Button>
        <Button variant="ghost" onClick={() => signOut()}>
          Sign out
        </Button>
      </form>
    </AuthShell>
  )
}
