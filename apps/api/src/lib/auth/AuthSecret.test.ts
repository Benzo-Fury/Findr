/**
 * Tests of the generated auth secret: created once with owner-only
 * permissions, read back unchanged on every later start, and never silently
 * replaced when the file is damaged.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { AuthSecret, SECRET_FILE } from "./AuthSecret"

let directory: string

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "findr-secret-"))
})

afterEach(() => {
  rmSync(directory, { recursive: true, force: true })
})

describe("AuthSecret", () => {
  test("generates a secret once and keeps it across starts", () => {
    const first = AuthSecret.load(directory)
    expect(first).toMatch(/^[0-9a-f]{64}$/)
    expect(AuthSecret.load(directory)).toBe(first)

    // Only the secret is left behind, readable by its owner alone
    expect(readdirSync(directory)).toEqual([SECRET_FILE])
    if (process.platform !== "win32") {
      expect(statSync(join(directory, SECRET_FILE)).mode & 0o777).toBe(0o600)
    }
  })

  test("refuses a file that holds no usable secret", () => {
    writeFileSync(join(directory, SECRET_FILE), "short\n")
    expect(() => AuthSecret.load(directory)).toThrow(/valid auth secret/)
  })

  test("lives only in memory without a directory", () => {
    expect(AuthSecret.load(null)).not.toBe(AuthSecret.load(null))
  })
})
