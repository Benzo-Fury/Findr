/**
 * The secret BetterAuth signs session cookies with. Nobody chooses or sees it:
 * it is generated on first run and kept in a file beside the database, so it
 * survives restarts and upgrades of the executable without any setup.
 *
 * It is deliberately not stored in the database. Sessions are stored there
 * with their tokens in the clear, and the secret is what stops a token read
 * from a copy of the database — a backup, an export, a file shared while
 * debugging — from being turned into a working signed cookie. Kept in its own
 * owner-only file, a leaked database alone cannot sign anyone in.
 */

import { randomBytes } from "node:crypto"
import { linkSync, readFileSync, unlinkSync, writeFileSync } from "node:fs"
import { join } from "node:path"

/** The file the secret lives in, inside the database's folder. */
export const SECRET_FILE = "auth.secret"

/** Random bytes in a new secret, written as hex. */
const SECRET_BYTES = 32

/** Shortest secret accepted from the file, in characters: BetterAuth's own minimum. */
const MIN_SECRET_LENGTH = 32

export class AuthSecret {
  /**
   * Returns the secret kept in `directory`, creating it on first run. With no
   * directory — an in-memory database, as in tests — returns a fresh secret
   * that lasts only as long as the process, like the database itself.
   */
  public static load(directory: string | null): string {
    if (directory === null) return this.generate()

    const path = join(directory, SECRET_FILE)
    return this.read(path) ?? this.create(path)
  }

  /**
   * Reads the secret from `path`, or null when the file does not exist. A
   * file that exists but holds no usable secret stops startup: replacing it
   * would silently sign everyone out, and it may mean the folder is not the
   * one Findr wrote.
   */
  private static read(path: string): string | null {
    let contents: string
    try {
      contents = readFileSync(path, "utf8")
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null
      throw error
    }

    const secret = contents.trim()
    if (secret.length < MIN_SECRET_LENGTH) {
      throw new Error(`${path} does not hold a valid auth secret; delete it to generate a new one (everyone will be signed out)`)
    }
    return secret
  }

  /**
   * Writes a new secret to `path`, readable only by this user. It is written
   * under a temporary name and then hard-linked into place, which fails if
   * the file already exists, so the secret never appears half-written and two
   * processes starting at once agree on the same one.
   */
  private static create(path: string): string {
    const secret = this.generate()
    const temporary = `${path}.${process.pid}.tmp`

    // Write the whole secret privately, then claim the real name atomically
    writeFileSync(temporary, `${secret}\n`, { mode: 0o600 })
    try {
      linkSync(temporary, path)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error

      // Another process created it first; use theirs
      const existing = this.read(path)
      if (existing === null) throw error
      return existing
    } finally {
      unlinkSync(temporary)
    }

    console.log(`[Auth] Generated the session signing secret in ${path}`)
    return secret
  }

  /** A new random secret. */
  private static generate(): string {
    return randomBytes(SECRET_BYTES).toString("hex")
  }
}
