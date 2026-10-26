/**
 * The one-time code that lets a fresh install be claimed from another
 * machine. Until the initial admin has replaced `admin` / `admin`, Findr only
 * answers the server itself — which, in a container or on a headless box,
 * is not where anyone has a browser. So while that is still to do, a random
 * code is printed in the server's log, and anyone who can read the log (and
 * so already controls the server) can enter it, with their real credentials,
 * from any machine.
 *
 * The code is made afresh on every start and lives only in memory. While it
 * is pending, `requireLocal` lets remote requests reach the web app and the
 * claim route — never the `admin` / `admin` sign-in, which stays local.
 */

import { randomInt, timingSafeEqual } from "node:crypto"
import type { Context } from "hono"
import { auth, ROOT_EMAIL } from "../auth/client"

/** Characters a code is made of: no 0/O or 1/I/L to misread. */
const ALPHABET = "23456789ABCDEFGHJKMNPQRSTUVWXYZ"

/** Groups of characters in a code, and characters per group: 12 characters, about 59 bits. */
const GROUPS = 3
const GROUP_LENGTH = 4

/** API paths a remote request may reach while the install is unclaimed. */
const OPEN_API_PATHS = new Set(["/api/setup/claim", "/api/auth/get-session"])

export class SetupCode {
  /** The current code, or null once the initial admin has its own credentials. */
  private static code: string | null = null

  /** Whether the initial admin still has to replace `admin` / `admin`. */
  public static get pending(): boolean {
    return this.code !== null
  }

  /** The code, for the startup log and tests; null when nothing is pending. */
  public static get current(): string | null {
    return this.code
  }

  /**
   * Makes a code when the initial admin still has to reset, or drops it when
   * that is done. Called by `seedRoot` at every start; a code already pending
   * is kept.
   */
  public static async sync(): Promise<void> {
    const context = await auth.$context
    const root = await context.internalAdapter.findUserByEmail(ROOT_EMAIL)
    const pending = Boolean((root?.user as { mustReset?: boolean } | undefined)?.mustReset)
    if (!pending) {
      this.code = null
      return
    }
    if (this.code) return

    this.code = this.generate()
    console.log(
      [
        "",
        "  ┌──────────────────────────────────────────────────────────────┐",
        `  │  Findr setup code: ${this.code.padEnd(42)}│`,
        "  │  Open Findr in a browser and enter it to choose your login.  │",
        "  │  On this machine you can sign in as admin / admin instead.   │",
        "  └──────────────────────────────────────────────────────────────┘",
        "",
      ].join("\n"),
    )
  }

  /** Whether `attempt` is the pending code. Case, spaces and dashes are ignored. */
  public static matches(attempt: string): boolean {
    if (!this.code) return false
    const normalise = (value: string) => value.toUpperCase().replace(/[\s-]/g, "")
    const expected = Buffer.from(normalise(this.code))
    const given = Buffer.from(normalise(attempt))
    return given.length === expected.length && timingSafeEqual(given, expected)
  }

  /** Forgets the code once the initial admin has its own credentials. */
  public static clear(): void {
    this.code = null
  }

  /**
   * Whether a remote request may get through while the install is unclaimed: the
   * web app's files, and the API calls its claim screen makes.
   */
  public static allows(c: Context): boolean {
    if (!this.pending) return false
    const path = c.req.path
    return !path.startsWith("/api/") || OPEN_API_PATHS.has(path)
  }

  /** A fresh code, like `7KQ4-MZ9C-X2PH`. */
  private static generate(): string {
    const groups = Array.from({ length: GROUPS }, () =>
      Array.from({ length: GROUP_LENGTH }, () => ALPHABET[randomInt(ALPHABET.length)]).join(""),
    )
    return groups.join("-")
  }
}
