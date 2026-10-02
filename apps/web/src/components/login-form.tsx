import * as React from "react"

import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { cn } from "@/lib/utils"
import { signIn } from "@/lib/auth"
import { AuthShell } from "@/components/auth-shell"

/**
 * Sign-in is the only way into the app. Sign-up is disabled on the server;
 * accounts are created by an admin on the settings page, so there is no
 * registration form and nothing here links to one. The email field is plain
 * text so a fresh install's `admin` login can be typed into it.
 */

interface LoginFormProps extends React.ComponentProps<"form"> {
  onSuccess?: () => void
}

export function LoginForm({ className, onSuccess, ...props }: LoginFormProps) {
  const [email, setEmail] = React.useState("")
  const [password, setPassword] = React.useState("")
  const [error, setError] = React.useState<string | null>(null)
  const [isPending, setIsPending] = React.useState(false)

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    setError(null)
    setIsPending(true)

    const { error } = await signIn.email({ email, password })

    setIsPending(false)

    if (error) {
      setError(error.message ?? "Invalid email or password.")
    } else {
      onSuccess?.()
    }
  }

  return (
    <form
      className={cn("flex flex-col gap-6", className)}
      onSubmit={handleSubmit}
      {...props}
    >
      <div className="flex flex-col items-center gap-1 text-center">
        <h1 className="text-2xl font-bold">Login to your account</h1>
        <p className="text-sm text-balance text-muted-foreground">
          Enter your email below to login to your account
        </p>
      </div>

      <div className="flex flex-col gap-4">
        <div className="flex flex-col gap-2">
          <Label htmlFor="email">Email</Label>
          <Input
            id="email"
            type="text"
            autoComplete="username"
            placeholder="m@example.com"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            required
          />
        </div>

        <div className="flex flex-col gap-2">
          <Label htmlFor="password">Password</Label>
          <Input
            id="password"
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            required
          />
        </div>

        {error && <p className="text-sm text-destructive">{error}</p>}

        <Button type="submit" disabled={isPending}>
          {isPending ? "Logging in..." : "Login"}
        </Button>
      </div>
    </form>
  )
}

export function LoginPage({ onSuccess }: { onSuccess?: () => void }) {
  return (
    <AuthShell>
      <LoginForm onSuccess={onSuccess} />
    </AuthShell>
  )
}
