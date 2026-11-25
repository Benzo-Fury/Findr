import * as React from "react"
import { ArrowRightIcon } from "@phosphor-icons/react"
import { fetchClaimStatus } from "@/lib/api"
import { signIn } from "@/lib/auth"
import { SetupWizard } from "@/components/setup/setup-wizard"
import { Button } from "@/components/ui/button"
import { Field, TextInput } from "@/components/ui/field"
import { AuthShell } from "@/components/shell/auth-shell"

/**
 * Sign-in, the only way in. Sign-up is disabled on the server, so nothing
 * here offers registration. The email field accepts plain text so a fresh
 * install's `admin` login can be typed into it.
 *
 * A fresh install opened from another machine (a container, a headless
 * server) can't use `admin` / `admin`, which only works on the server itself,
 * so it gets setup's claim step instead: the code from the server's log and a
 * real login.
 */
export function LoginPage() {
  const [claim, setClaim] = React.useState<{ pending: boolean; local: boolean } | null>(null)

  React.useEffect(() => {
    fetchClaimStatus()
      .then(setClaim)
      .catch(() => setClaim({ pending: false, local: true }))
  }, [])

  if (claim?.pending && !claim.local) return <SetupWizard account="claim" />
  return <SignInForm firstRun={Boolean(claim?.pending)} />
}

/** The sign-in form; on a fresh install, with a hint about the initial login. */
function SignInForm({ firstRun }: { firstRun: boolean }) {
  const [email, setEmail] = React.useState("")
  const [password, setPassword] = React.useState("")
  const [error, setError] = React.useState<string | null>(null)
  const [pending, setPending] = React.useState(false)

  async function submit(event: React.FormEvent) {
    event.preventDefault()
    setError(null)
    setPending(true)
    const { error: failure } = await signIn.email({ email, password })
    setPending(false)
    if (failure) setError(failure.message ?? "That email and password do not match an account.")
  }

  return (
    <AuthShell
      title="Sign in"
      description={firstRun ? "First time here? Sign in as admin with the password admin, then choose your own." : "Your library, your downloads, one place."}
    >
      <form onSubmit={submit} className="flex flex-col gap-5">
        <Field label="Email">
          {({ id }) => <TextInput id={id} type="text" autoComplete="username" autoFocus value={email} onChange={(event) => setEmail(event.target.value)} required />}
        </Field>
        <Field label="Password" error={error}>
          {({ id, describedBy, invalid }) => (
            <TextInput id={id} type="password" autoComplete="current-password" aria-describedby={describedBy} aria-invalid={invalid || undefined} value={password} onChange={(event) => setPassword(event.target.value)} required />
          )}
        </Field>
        <Button type="submit" variant="signal" size="lg" iconEnd={ArrowRightIcon} loading={pending} className="mt-2 w-full">
          Sign in
        </Button>
      </form>
    </AuthShell>
  )
}
