/**
 * Pins who may call every API route. Each route file's access is checked
 * against the table below, so adding a route, or loosening one, fails here
 * until the table is changed on purpose. Then every method of every protected
 * route is called through the real route chain as a visitor, a signed-in user
 * and an admin still on its initial credentials, and must be turned away
 * before its handler runs.
 */

import { beforeAll, beforeEach, describe, expect, test } from "bun:test"
import { METHODS } from "hono/router"
import type { HttpMethod, Route } from "../../types/Route"
import { auth, migrateAuth, seedRoot } from "../auth/client"
import { database } from "../db/client"
import { derivePath } from "../routing/derivePath"
import { Server } from "./Server"
import { ServerAddress } from "./ServerAddress"

/** Who a route admits: anyone, any signed-in account, or admins only. */
type Access = "public" | "user" | "admin"

/** The intended access of every route. A route missing here, or differing from it, fails the suite. */
const EXPECTED: Record<string, Access> = {
  "/api/account/credentials": "user",
  "/api/auth/**": "public",
  "/api/downloads": "user",
  "/api/downloads/:id": "user",
  "/api/downloads/:id/cancel": "user",
  "/api/downloads/:id/retry": "user",
  "/api/health": "public",
  "/api/playback/admin/encoder-test": "admin",
  "/api/playback/admin/sessions": "admin",
  "/api/playback/admin/sessions/:id": "admin",
  "/api/playback/bridges": "admin",
  "/api/playback/bridges/:id": "admin",
  "/api/playback/bridges/connect": "public",
  "/api/playback/capabilities": "user",
  "/api/playback/cast": "user",
  "/api/playback/cast/:ticket/:file": "public",
  "/api/playback/casts": "user",
  "/api/playback/library": "user",
  "/api/playback/played": "user",
  "/api/playback/prefs": "user",
  "/api/playback/progress": "user",
  "/api/playback/renderers": "user",
  "/api/playback/renderers/:id": "user",
  "/api/playback/renderers/:id/command": "user",
  "/api/playback/renderers/:id/play": "user",
  "/api/playback/renderers/:id/splash": "user",
  "/api/playback/sessions": "user",
  "/api/playback/sessions/:id": "user",
  "/api/playback/splash": "public",
  "/api/playback/stream/:token/:file": "public",
  "/api/playback/trickplay/:id/:file": "user",
  "/api/settings": "admin",
  "/api/setup": "admin",
  "/api/setup/claim": "public",
  "/api/titles": "user",
  "/api/titles/:id": "user",
  "/api/tmdb/browse": "user",
  "/api/tmdb/cards": "user",
  "/api/tmdb/details/:mediaType/:id": "user",
  "/api/tmdb/discover-feed": "user",
  "/api/tmdb/featured": "public",
  "/api/tmdb/genres": "user",
  "/api/tmdb/list/:source": "user",
  "/api/tmdb/search": "user",
  "/api/updates": "user",
  "/api/updates/check": "admin",
  "/api/updates/install": "admin",
  "/api/vpn": "admin",
  "/api/vpn/check": "admin",
}

/** The only routes an account still on its initial credentials may use. */
const ALLOWED_PENDING_RESET = new Set(["/api/account/credentials"])

const ORIGIN = ServerAddress.localUrl
const server = new Server()
const routes: Record<string, Route> = {}

/** The access a route declares, resolved the way `Server.constructRoutes` does. */
function accessOf(route: Route): Access {
  if (route.admin) return "admin"
  return route.authenticated ? "user" : "public"
}

/** The HTTP methods a route answers. */
function methodsOf(route: Route): HttpMethod[] {
  return METHODS.map((method) => method.toUpperCase() as HttpMethod).filter((method) => route[method] !== undefined)
}

/** A concrete URL for a route pattern, with placeholders filled in. */
function urlFor(path: string): string {
  return path.replace(/:\w+/g, "1").replace("**", "anything")
}

/** Sends a request through the app from loopback, carrying `cookie` when given. */
function call(path: string, method: string, cookie?: string, body?: unknown) {
  const headers: Record<string, string> = { origin: ORIGIN }
  if (body !== undefined) headers["content-type"] = "application/json"
  if (cookie) headers.cookie = cookie

  const request = new Request(`${ORIGIN}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) })
  return server.fetch(request, { requestIP: () => ({ address: "127.0.0.1", family: "IPv4", port: 50000 }) })
}

/** Signs in and returns the session cookie. */
async function signIn(email: string, password: string): Promise<string> {
  const res = await call("/api/auth/sign-in/email", "POST", undefined, { email, password })
  expect(res.status).toBe(200)
  return res.headers.getSetCookie().map((cookie) => cookie.split(";")[0]).join("; ")
}

/** Creates an ordinary, non-admin account that has already set its credentials. */
async function createUser(email: string, password: string): Promise<void> {
  const context = await auth.$context
  const user = await context.internalAdapter.createUser({ email, name: "User", emailVerified: false, role: "user", mustReset: false })
  await context.internalAdapter.linkAccount({ userId: user.id, accountId: user.id, providerId: "credential", password: await context.password.hash(password) })
}

beforeAll(async () => {
  await migrateAuth()
  await server.constructRoutes()

  // The route files, found the same way the server finds them in development
  for await (const file of new Bun.Glob("**/*.ts").scan(`${import.meta.dir}/../../routes`)) {
    routes[derivePath(file)] = (await import(`../../routes/${file}`)).default
  }
})

beforeEach(async () => {
  for (const table of ["session", "account", "user"]) database.run(`DELETE FROM "${table}"`)
  await seedRoot()
})

describe("route access", () => {
  test("every route declares the access in the table, and the table names no missing route", () => {
    const declared = Object.fromEntries(Object.entries(routes).map(([path, route]) => [path, accessOf(route)]))
    expect(declared).toEqual(EXPECTED)
  })

  test("only the credential reset admits an account that still has to reset", () => {
    const allowed = Object.entries(routes).filter(([, route]) => route.allowPendingReset).map(([path]) => path)
    expect(new Set(allowed)).toEqual(ALLOWED_PENDING_RESET)
  })

  test("visitors are refused by every route that is not public", async () => {
    for (const [path, route] of Object.entries(routes)) {
      if (EXPECTED[path] === "public") continue
      for (const method of methodsOf(route)) {
        const res = await call(urlFor(path), method)
        expect({ route: `${method} ${path}`, status: res.status }).toEqual({ route: `${method} ${path}`, status: 401 })
      }
    }
  })

  test("signed-in users who are not admins are refused by every admin route", async () => {
    await createUser("user@example.com", "a-long-password")
    const cookie = await signIn("user@example.com", "a-long-password")

    for (const [path, route] of Object.entries(routes)) {
      if (EXPECTED[path] !== "admin") continue
      for (const method of methodsOf(route)) {
        const res = await call(urlFor(path), method, cookie)
        expect({ route: `${method} ${path}`, body: await res.json() }).toEqual({ route: `${method} ${path}`, body: { error: "forbidden" } })
      }
    }
  })

  test("an admin still on its initial credentials is refused by every other protected route", async () => {
    const cookie = await signIn("admin", "admin")

    for (const [path, route] of Object.entries(routes)) {
      if (EXPECTED[path] === "public" || ALLOWED_PENDING_RESET.has(path)) continue
      for (const method of methodsOf(route)) {
        const res = await call(urlFor(path), method, cookie)
        expect({ route: `${method} ${path}`, body: await res.json() }).toEqual({ route: `${method} ${path}`, body: { error: "reset_required" } })
      }
    }
  })
})
