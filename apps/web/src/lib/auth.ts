/**
 * BetterAuth client. The API mounts its auth handler under `/api/auth` on the
 * same origin the app is served from, so no base URL needs configuring. The
 * admin plugin adds user management (`authClient.admin.*`) and the user's
 * `role`, which decides whether the settings page is available. `mustReset`
 * mirrors the server's user field: set on the initial `admin` account until it
 * replaces its credentials.
 */

import { createAuthClient } from "better-auth/react"
import { adminClient, inferAdditionalFields } from "better-auth/client/plugins"

export const authClient = createAuthClient({
  plugins: [
    adminClient(),
    inferAdditionalFields({ user: { mustReset: { type: "boolean", required: false, input: false } } }),
  ],
})

export const { signIn, signOut, useSession } = authClient

/** A signed-in session, as `useSession` returns it. */
export type Session = typeof authClient.$Infer.Session

/** Whether the signed-in user may manage settings and accounts. */
export function isAdmin(session: Session): boolean {
  return session.user.role === "admin"
}

/** Whether the signed-in account must replace its initial credentials before anything else. */
export function mustReset(session: Session): boolean {
  return session.user.mustReset === true
}
