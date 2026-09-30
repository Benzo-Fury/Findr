/**
 * BetterAuth client. The API mounts its auth handler under `/api/auth` on the
 * same origin the app is served from, so no base URL needs configuring.
 */

import { createAuthClient } from "better-auth/react"

export const authClient = createAuthClient()

export const { signIn, signOut, useSession } = authClient
