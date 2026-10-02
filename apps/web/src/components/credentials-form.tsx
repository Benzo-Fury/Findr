import * as React from "react"

import { MIN_PASSWORD_LENGTH } from "@findr/types/account"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { AuthShell } from "@/components/auth-shell"
import { resetCredentials } from "@/lib/api"
import { signOut, useSession } from "@/lib/auth"

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
  const [isPending, setIsPending] = React.useState(false)

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    if (password !== confirm) {
      setError("The passwords do not match.")
      return
    }

    setError(null)
    setIsPending(true)
    try {
      await resetCredentials({ email, password })
      // The session now reads without the reset flag, which swaps in the app
      await refetch()
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not save your credentials.")
      setIsPending(false)
    }
  }

  return (
    <AuthShell>
      <form className="flex flex-col gap-6" onSubmit={handleSubmit}>
        <div className="flex flex-col items-center gap-1 text-center">
          <h1 className="text-2xl font-bold">Set up your account</h1>
          <p className="text-sm text-balance text-muted-foreground">
            Replace the default admin login with your own email and password.
          </p>
        </div>

        <div className="flex flex-col gap-4">
          <div className="flex flex-col gap-2">
            <Label htmlFor="email">Email</Label>
            <Input id="email" type="email" autoComplete="username" placeholder="m@example.com" value={email} onChange={(e) => setEmail(e.target.value)} required />
          </div>

          <div className="flex flex-col gap-2">
            <Label htmlFor="password">New password</Label>
            <Input id="password" type="password" autoComplete="new-password" minLength={MIN_PASSWORD_LENGTH} value={password} onChange={(e) => setPassword(e.target.value)} required />
            <p className="text-xs text-muted-foreground">At least {MIN_PASSWORD_LENGTH} characters.</p>
          </div>

          <div className="flex flex-col gap-2">
            <Label htmlFor="confirm">Confirm password</Label>
            <Input id="confirm" type="password" autoComplete="new-password" value={confirm} onChange={(e) => setConfirm(e.target.value)} required />
          </div>

          {error && <p className="text-sm text-destructive">{error}</p>}

          <Button type="submit" disabled={isPending}>
            {isPending ? "Saving..." : "Save and continue"}
          </Button>
          <Button type="button" variant="ghost" onClick={() => signOut()}>
            Sign out
          </Button>
        </div>
      </form>
    </AuthShell>
  )
}
