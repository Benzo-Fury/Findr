/**
 * Authentication. BetterAuth owns sessions, passwords and its own tables
 * (`user`, `session`, `account`, `verification`) on the shared SQLite
 * connection; nothing else in the application touches them.
 *
 * Findr is a private server, so self-service sign-up is switched off
 * entirely. Accounts are created only by a signed-in admin through the admin
 * plugin, and the very first admin is seeded from the environment when the
 * database has no users.
 */

import { betterAuth } from "better-auth"
import { admin } from "better-auth/plugins"
import { database } from "../db/client"
import { env } from "../env/Env"

/** The BetterAuth instance every auth route and session check goes through. */
export const auth = betterAuth({
  basePath: "/api/auth",
  database,
  emailAndPassword: {
    enabled: true,
    // Rejects /sign-up/email outright; admins create accounts instead
    disableSignUp: true,
  },
  plugins: [admin()],
  baseURL: env.BASE_URL,
  secret: env.BETTER_AUTH_SECRET,
  trustedOrigins: env.NODE_ENV === "development"
    ? ["http://localhost:5173"]
    : [],
})

/** A signed-in session, as `requireAuth` stores it on the request context. */
export type AuthSession = typeof auth.$Infer.Session

/**
 * Creates any of BetterAuth's tables that are missing. Its schema is derived
 * from the options above rather than declared anywhere in this repo, so
 * enabling a plugin or upgrading BetterAuth adds the tables and columns it
 * needs on the next boot.
 *
 * Diffs against the live database and only issues what is absent, so it is
 * safe to call on every startup. Must finish before the server handles its
 * first request.
 */
export async function migrateAuth(): Promise<void> {
  const context = await auth.$context
  await context.runMigrations()
}

/**
 * Seeds the first admin from `FINDR_ADMIN_EMAIL` and `FINDR_ADMIN_PASSWORD`
 * when no user exists yet. With sign-up disabled this is the only way into a
 * fresh install. Does nothing once any account exists, so the variables can be
 * removed after first boot.
 */
export async function bootstrapAdmin(): Promise<void> {
  const context = await auth.$context
  if ((await context.internalAdapter.countTotalUsers()) > 0) return

  // Without credentials there is no way in; say so loudly
  if (!env.FINDR_ADMIN_EMAIL || !env.FINDR_ADMIN_PASSWORD) {
    console.warn("[Auth] No users exist. Set FINDR_ADMIN_EMAIL and FINDR_ADMIN_PASSWORD to create the first admin.")
    return
  }

  // A server-side call with no request headers runs without a session check
  await auth.api.createUser({
    body: { email: env.FINDR_ADMIN_EMAIL, password: env.FINDR_ADMIN_PASSWORD, name: "Admin", role: "admin" },
  })
  console.log(`[Auth] Created the first admin account (${env.FINDR_ADMIN_EMAIL})`)
}
