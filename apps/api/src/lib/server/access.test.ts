/**
 * End-to-end tests of who can reach the server: the initial `admin` / `admin`
 * account and its forced credential reset, secret redaction in the settings
 * response, and the localhost-only rule. Requests go through the real route
 * chain; the socket address is faked by handing `fetch` a stand-in Bun server.
 */

import { beforeAll, beforeEach, describe, expect, test } from "bun:test"
import { migrateAuth, ROOT_EMAIL, seedRoot } from "../auth/client"
import { database } from "../db/client"
import { SettingsStore } from "../db/models/SettingsStore"
import { env } from "../env/Env"
import { Server } from "./Server"

const ORIGIN = "http://localhost:3030"
const server = new Server()

/** A stand-in for the Bun server, reporting every request as coming from `address`. */
function from(address: string) {
  return { requestIP: () => ({ address, family: address.includes(":") ? "IPv6" : "IPv4", port: 50000 }) }
}

/** Sends a request through the app as if from `address`, carrying `cookie` when given. */
function call(path: string, init: { method?: string; body?: unknown; cookie?: string; address?: string; headers?: Record<string, string> } = {}) {
  const headers: Record<string, string> = { origin: ORIGIN, ...init.headers }
  if (init.body !== undefined) headers["content-type"] = "application/json"
  if (init.cookie) headers.cookie = init.cookie

  const request = new Request(`${ORIGIN}${path}`, {
    method: init.method ?? (init.body === undefined ? "GET" : "POST"),
    headers,
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
  })
  return server.fetch(request, from(init.address ?? "127.0.0.1"))
}

/** Signs in and returns the session cookie, or null when the credentials were refused. */
async function signIn(email: string, password: string): Promise<string | null> {
  const res = await call("/api/auth/sign-in/email", { body: { email, password } })
  if (!res.ok) return null
  return res.headers.getSetCookie().map((cookie) => cookie.split(";")[0]).join("; ")
}

beforeAll(async () => {
  await migrateAuth()
  await server.constructRoutes()
})

beforeEach(async () => {
  for (const table of ["session", "account", "user", "settings"]) database.run(`DELETE FROM "${table}"`)
  await seedRoot()
})

describe("initial admin", () => {
  test("is seeded once, as an admin that must reset", async () => {
    await seedRoot()
    const users = database.query<{ email: string; role: string; mustReset: number }, []>(`SELECT email, role, mustReset FROM "user"`).all()
    expect(users).toEqual([{ email: ROOT_EMAIL, role: "admin", mustReset: 1 }])
  })

  test("signs in as admin / admin, and can do nothing else until it resets", async () => {
    const cookie = await signIn("admin", "admin")
    expect(cookie).not.toBeNull()

    // App routes and BetterAuth's own endpoints are both closed
    const settings = await call("/api/settings", { cookie: cookie! })
    expect(settings.status).toBe(403)
    expect(await settings.json()).toEqual({ error: "reset_required" })
    const changePassword = await call("/api/auth/change-password", { cookie: cookie!, body: { currentPassword: "admin", newPassword: "something-long" } })
    expect(changePassword.status).toBe(403)

    // The session itself still reads
    expect((await call("/api/auth/get-session", { cookie: cookie! })).status).toBe(200)
  })

  test("must choose a real email and a long enough password", async () => {
    const cookie = await signIn("admin", "admin")

    const short = await call("/api/account/credentials", { cookie: cookie!, body: { email: "me@example.com", password: "short" } })
    expect(short.status).toBe(400)
    const unchanged = await call("/api/account/credentials", { cookie: cookie!, body: { email: ROOT_EMAIL, password: "a-long-password" } })
    expect(await unchanged.json()).toEqual({ error: "email_unchanged" })
  })

  test("replaces admin / admin with real credentials", async () => {
    const cookie = await signIn("admin", "admin")
    const other = await signIn("admin", "admin")

    const reset = await call("/api/account/credentials", { cookie: cookie!, body: { email: "Me@Example.com", password: "a-long-password" } })
    expect(reset.status).toBe(204)

    // The resetting session carries on; any other admin / admin session is gone
    expect((await call("/api/settings", { cookie: cookie! })).status).toBe(200)
    expect((await call("/api/settings", { cookie: other! })).status).toBe(401)

    // Only the new credentials work now, and the reset cannot be repeated
    expect(await signIn("admin", "admin")).toBeNull()
    expect(await signIn("me@example.com", "a-long-password")).not.toBeNull()
    const again = await call("/api/account/credentials", { cookie: cookie!, body: { email: "you@example.com", password: "another-password" } })
    expect(await again.json()).toEqual({ error: "reset_not_required" })

    // BetterAuth's own endpoints open up again
    const changePassword = await call("/api/auth/change-password", { cookie: cookie!, body: { currentPassword: "a-long-password", newPassword: "another-password" } })
    expect(changePassword.status).toBe(200)
  })
})

describe("settings response", () => {
  test("never contains a secret, only whether it is set", async () => {
    const cookie = await signIn("admin", "admin")
    await call("/api/account/credentials", { cookie: cookie!, body: { email: "me@example.com", password: "a-long-password" } })

    const res = await call("/api/settings", { cookie: cookie!, method: "PATCH", body: { services: { tmdbApiKey: "tmdb-secret", prowlarrUrl: "http://prowlarr:9696" } } })
    const body = await res.json()

    expect(JSON.stringify(body)).not.toContain("tmdb-secret")
    expect(body.settings.services.prowlarrUrl).toBe("http://prowlarr:9696")
    expect(body.configured).toEqual({ tmdbApiKey: true, prowlarrApiKey: false, anthropicApiKey: false })
    expect(SettingsStore.section("services").tmdbApiKey).toBe("tmdb-secret")
  })
})

describe("remote access", () => {
  test("is refused by default, for the API and the web app alike", async () => {
    const api = await call("/api/health", { address: "192.168.1.20" })
    expect(api.status).toBe(403)
    expect(await api.json()).toEqual({ error: "remote_access_disabled" })
    expect((await call("/", { address: "192.168.1.20" })).status).toBe(403)
  })

  test("is always allowed from loopback", async () => {
    for (const address of ["127.0.0.1", "::1", "::ffff:127.0.0.1"]) {
      expect((await call("/api/health", { address })).status).toBe(200)
    }
  })

  test("treats a local proxy relaying a client as remote unless the proxy is trusted", async () => {
    const relayed = { "x-forwarded-for": "203.0.113.9" }
    expect((await call("/api/health", { headers: relayed })).status).toBe(403)

    env.TRUST_PROXY = true
    try {
      expect((await call("/api/health", { headers: relayed })).status).toBe(403)
      expect((await call("/api/health", { headers: { "x-forwarded-for": "127.0.0.1" } })).status).toBe(200)
    } finally {
      env.TRUST_PROXY = false
    }
  })

  test("opens once enabled in the settings", async () => {
    SettingsStore.update({ access: { allowRemote: true } })
    expect((await call("/api/health", { address: "192.168.1.20" })).status).toBe(200)
  })
})
