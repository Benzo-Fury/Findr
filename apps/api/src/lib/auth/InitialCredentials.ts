/**
 * Replaces the initial admin's `admin` / `admin` credentials with real ones —
 * the one thing an account flagged `mustReset` is allowed to do. Writes go
 * through BetterAuth's internal adapter, so its tables stay its own.
 */

import type { CredentialsReset } from "@findr/types/account"
import { auth, ROOT_EMAIL, type AuthSession } from "./client"

/** Why a reset was refused. */
export type ResetRefusal = "reset_not_required" | "email_unchanged" | "email_taken"

export class InitialCredentials {
  /**
   * Sets the account's new email and password, clears its `mustReset` flag,
   * and signs out every other session that may have used the old
   * credentials. Returns why it refused, or null once done. The session is
   * the caller's own, read fresh from the database on this request.
   *
   * The flag is cleared last, so a failure part-way leaves the account still
   * locked to resetting rather than half-changed and open.
   */
  public static async replace({ user, session }: AuthSession, credentials: CredentialsReset): Promise<ResetRefusal | null> {
    const context = await auth.$context
    const adapter = context.internalAdapter
    const userId = user.id

    // Only an account still on its initial credentials resets this way
    if (!user.mustReset) return "reset_not_required"

    // The new address must be a real one, and nobody else's
    if (credentials.email === ROOT_EMAIL) return "email_unchanged"
    const existing = await adapter.findUserByEmail(credentials.email)
    if (existing && existing.user.id !== userId) return "email_taken"

    // Swap the password, then the email, then lift the flag
    await adapter.updatePassword(userId, await context.password.hash(credentials.password))
    await adapter.updateUser(userId, { email: credentials.email, emailVerified: false })
    await adapter.updateUser(userId, { mustReset: false })

    // Anyone else who signed in with admin / admin is signed out
    const others = (await adapter.listSessions(userId)).filter((other) => other.token !== session.token)
    if (others.length > 0) await adapter.deleteSessions(others.map((other) => other.token))

    return null
  }
}
