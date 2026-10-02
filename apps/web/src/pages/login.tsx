import * as React from "react"
import { ArrowRightIcon } from "@phosphor-icons/react"
import { signIn } from "@/lib/auth"
import { Button } from "@/components/ui/button"
import { Field, TextInput } from "@/components/ui/field"
import { AuthShell } from "@/components/shell/auth-shell"

/**
 * Sign-in, the only way in. Sign-up is disabled on the server, so nothing
 * here offers registration. The email field accepts plain text so a fresh
 * install's `admin` login can be typed into it.
 */
export function LoginPage() {
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
    <AuthShell title="Sign in" description="Your library, your downloads, one place.">
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
