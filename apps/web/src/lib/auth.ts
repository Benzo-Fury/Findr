/**
 * BetterAuth client. The API mounts its auth handler under `/api/auth` on the
 * same origin the app is served from, so no base URL needs configuring. The
 * admin plugin adds user management (`authClient.admin.*`) and the user's
 * `role`, which decides whether the settings page is available.
 */

import { createAuthClient } from "better-auth/react"
import { adminClient } from "better-auth/client/plugins"

export const authClient = createAuthClient({
  plugins: [adminClient()],
})

export const { signIn, signOut, useSession } = authClient

/** A signed-in session, as `useSession` returns it. */
export type Session = typeof authClient.$Infer.Session

/** Whether the signed-in user may manage settings and accounts. */
export function isAdmin(session: Session): boolean {
  return session.user.role === "admin"
}
