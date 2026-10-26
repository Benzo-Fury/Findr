/**
 * Replaces the initial admin's `admin` / `admin` credentials with real ones —
 * the one thing an account flagged `mustReset` is allowed to do. It happens
 * either signed in as `admin` on the server itself, or from anywhere with the
 * setup code from the server's log (`SetupCode`). Writes go through
 * BetterAuth's internal adapter, so its tables stay its own.
 */

import type { CredentialsReset } from "@findr/types/account"
import { SetupCode } from "../setup/SetupCode"
import { auth, ROOT_EMAIL, type AuthSession } from "./client"

/** Why a reset was refused. */
export type ResetRefusal = "reset_not_required" | "email_unchanged" | "email_taken" | "invalid_setup_code"

export class InitialCredentials {
  /**
   * Sets the signed-in account's new email and password, clears its
   * `mustReset` flag, and signs out every other session that may have used
   * the old credentials. Returns why it refused, or null once done. The
   * session is the caller's own, read fresh from the database on this
   * request.
   */
  public static async replace({ user, session }: AuthSession, credentials: CredentialsReset): Promise<ResetRefusal | null> {
    // Only an account still on its initial credentials resets this way
    if (!user.mustReset) return "reset_not_required"
    return this.apply(user.id, credentials, session.token)
  }

  /**
   * Sets the initial admin's email and password with the setup code instead
   * of a session, and signs out every session it has. Returns why it
   * refused, or null once done; the caller then signs in as usual.
   */
  public static async claim(code: string, credentials: CredentialsReset): Promise<ResetRefusal | null> {
    if (!SetupCode.pending) return "reset_not_required"
    if (!SetupCode.matches(code)) return "invalid_setup_code"

    const context = await auth.$context
    const root = await context.internalAdapter.findUserByEmail(ROOT_EMAIL)
    if (!root || !(root.user as { mustReset?: boolean }).mustReset) return "reset_not_required"
    return this.apply(root.user.id, credentials, null)
  }

  /**
   * Swaps the password, then the email, then lifts the flag, signing out
   * every session but `keepToken`. The flag is cleared last, so a failure
   * part-way leaves the account still locked to resetting rather than
   * half-changed and open.
   */
  private static async apply(userId: string, credentials: CredentialsReset, keepToken: string | null): Promise<ResetRefusal | null> {
    const context = await auth.$context
    const adapter = context.internalAdapter

    // The new address must be a real one, and nobody else's
    if (credentials.email === ROOT_EMAIL) return "email_unchanged"
    const existing = await adapter.findUserByEmail(credentials.email)
    if (existing && existing.user.id !== userId) return "email_taken"

    // Swap the password, then the email, then lift the flag
    await adapter.updatePassword(userId, await context.password.hash(credentials.password))
    await adapter.updateUser(userId, { email: credentials.email, emailVerified: false })
    await adapter.updateUser(userId, { mustReset: false })
    SetupCode.clear()

    // Anyone else who signed in with admin / admin is signed out
    const others = (await adapter.listSessions(userId)).filter((other) => other.token !== keepToken)
    if (others.length > 0) await adapter.deleteSessions(others.map((other) => other.token))

    return null
  }
}
