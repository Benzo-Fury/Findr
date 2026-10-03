/**
 * Authentication. BetterAuth owns sessions, passwords and its own tables
 * (`user`, `session`, `account`, `verification`) on the shared SQLite
 * connection; nothing else in the application touches them.
 *
 * Findr is a private server, so self-service sign-up is switched off
 * entirely. Accounts are created only by a signed-in admin through the admin
 * plugin. A fresh install seeds a single admin that signs in as `admin` /
 * `admin` and carries the `mustReset` flag: until it replaces both, the only
 * thing it can do is sign out or set its real credentials.
 */

import { MAX_PASSWORD_LENGTH, MIN_PASSWORD_LENGTH } from "@findr/types/account"
import { betterAuth } from "better-auth"
import { APIError, createAuthMiddleware, getSessionFromCtx } from "better-auth/api"
import { admin } from "better-auth/plugins"
import { client, database } from "../db/client"
import { ServerAddress } from "../server/ServerAddress"
import { AuthSecret } from "./AuthSecret"

// ---------- Initial admin ---------- //

/** What the initial admin types to sign in, as both the login and the password. */
export const ROOT_LOGIN = "admin"

/**
 * The address the initial admin is stored under. BetterAuth only signs in
 * with well-formed email addresses, so the bare `admin` login is mapped onto
 * this one; it is replaced by a real address on first sign-in.
 */
export const ROOT_EMAIL = "admin@findr.local"

/** BetterAuth endpoints an account still on its initial credentials may use. */
const PENDING_RESET_PATHS = new Set(["/sign-in/email", "/sign-out", "/get-session"])

/**
 * Runs before every BetterAuth endpoint. Maps the bare `admin` login onto the
 * initial admin's stored address, and keeps an account that has not replaced
 * its initial credentials away from everything else BetterAuth offers —
 * changing its password the ordinary way, or managing other accounts.
 */
const credentialsGuard = createAuthMiddleware(async (ctx) => {
  // Let the initial admin sign in as plain `admin`
  if (ctx.path === "/sign-in/email") {
    const email: unknown = ctx.body?.email
    if (typeof email === "string" && email.trim().toLowerCase() === ROOT_LOGIN) {
      return { context: { body: { ...ctx.body, email: ROOT_EMAIL } } }
    }
    return
  }
  if (PENDING_RESET_PATHS.has(ctx.path)) return

  // Anything else waits until the initial credentials are gone
  const session = await getSessionFromCtx<{ mustReset: boolean }>(ctx)
  if (session?.user.mustReset) {
    throw new APIError("FORBIDDEN", { message: "reset_required" })
  }

  // An admin never changes their own role, so at least one admin always remains
  if (session && changesOwnRole(ctx.path, ctx.body, session.user.id)) {
    throw new APIError("BAD_REQUEST", { message: "own_role" })
  }
})

/**
 * Whether a request to `path` would change the role of `userId`, either
 * through the admin plugin's `set-role` or a `role` inside `update-user`.
 */
function changesOwnRole(path: string, body: unknown, userId: string): boolean {
  if (typeof body !== "object" || body === null) return false
  const fields = body as { userId?: unknown; data?: unknown }
  if (fields.userId !== userId) return false
  if (path === "/admin/set-role") return true
  return path === "/admin/update-user" && typeof fields.data === "object" && fields.data !== null && "role" in fields.data
}

// ---------- BetterAuth ---------- //

/** The BetterAuth instance every auth route and session check goes through. */
export const auth = betterAuth({
  basePath: "/api/auth",
  database,
  emailAndPassword: {
    enabled: true,
    // Rejects /sign-up/email outright; admins create accounts instead
    disableSignUp: true,
    minPasswordLength: MIN_PASSWORD_LENGTH,
    maxPasswordLength: MAX_PASSWORD_LENGTH,
  },
  user: {
    additionalFields: {
      /** Set on the initial admin: it must replace its email and password before anything else. */
      mustReset: { type: "boolean", required: false, defaultValue: false, input: false },
    },
  },
  hooks: { before: credentialsGuard },
  plugins: [admin()],
  baseURL: ServerAddress.baseUrl,
  secret: AuthSecret.load(client.directory),
  trustedOrigins: (request) => ServerAddress.trustedOrigins(request),
  // BetterAuth skips its origin check under test; keep it on so tests see what production does
  advanced: { disableOriginCheck: false },
})

/** A signed-in session, as `requireAuth` stores it on the request context. */
export type AuthSession = typeof auth.$Infer.Session

/**
 * Creates any of BetterAuth's tables and columns that are missing. Its schema
 * is derived from the options above rather than declared anywhere in this
 * repo, so enabling a plugin, adding a user field or upgrading BetterAuth
 * adds what it needs on the next boot.
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
 * Seeds the initial admin when no account exists yet: `admin` / `admin`,
 * flagged to replace both on first sign-in. With sign-up disabled this is the
 * only way into a fresh install. Does nothing once any account exists.
 *
 * Writes through the internal adapter rather than the admin plugin's
 * `createUser`, since `admin` is neither a valid email nor a long enough
 * password for the public endpoints.
 */
export async function seedRoot(): Promise<void> {
  const context = await auth.$context
  if ((await context.internalAdapter.countTotalUsers()) > 0) return

  // The user, then the password it signs in with
  const user = await context.internalAdapter.createUser({
    email: ROOT_EMAIL,
    name: "Admin",
    emailVerified: false,
    role: "admin",
    mustReset: true,
  })
  await context.internalAdapter.linkAccount({
    userId: user.id,
    accountId: user.id,
    providerId: "credential",
    password: await context.password.hash(ROOT_LOGIN),
  })
  console.log(`[Auth] Created the initial admin; sign in as ${ROOT_LOGIN} / ${ROOT_LOGIN} from this machine to set real credentials`)
}
