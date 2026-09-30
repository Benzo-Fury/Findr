import * as React from "react"

import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { cn } from "@/lib/utils"
import { signIn } from "@/lib/auth"
import { MediaGrid } from "@/components/media-grid"

/**
 * Sign-in is the only way into the app. Sign-up is disabled on the server;
 * accounts are created by an admin on the settings page, so there is no
 * registration form and nothing here links to one.
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
            type="email"
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
    <div className="relative min-h-svh overflow-hidden bg-black">
      <MediaGrid />
      <div className="relative z-30 flex min-h-svh items-center justify-center p-4">
        <div className="w-full max-w-sm rounded-2xl border border-white/10 bg-background/90 p-8 shadow-2xl backdrop-blur-md">
          <div className="mb-8 flex items-center justify-center gap-2">
            <img src="/findr-logo.svg" alt="Findr" className="size-7" />
            <span className="text-lg font-bold" style={{ color: "oklch(0.77 0.165 70)" }}>
              Findr
            </span>
          </div>
          <LoginForm onSuccess={onSuccess} />
        </div>
      </div>
    </div>
  )
}
