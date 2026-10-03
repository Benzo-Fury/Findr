/**
 * Extends Hono into a self-contained application server that handles route
 * discovery, registration, and port binding.
 *
 * Route discovery is environment-aware: in dev, routes are found at runtime
 * via filesystem glob; in prod, they come from the pre-generated static
 * route map built by the cartographer.
 */

import { Hono } from "hono"
import { METHODS } from "hono/router"
import type { Route, HttpMethod } from "../../types/Route"
import { env } from "../env/Env"
import { RateLimiter } from "../../middleware/RateLimiter"
import { requireAdmin } from "../../middleware/requireAdmin"
import { requireAuth } from "../../middleware/requireAuth"
import { requireLocal } from "../../middleware/requireLocal"
import { blockPendingReset } from "../../middleware/blockPendingReset"
import { validateBody } from "../../middleware/validateBody"
import { validateQuery } from "../../middleware/validateQuery"
import { derivePath } from "../routing/derivePath"
import { WebAssets } from "./WebAssets"

/**
 * Application HTTP server.
 *
 * Inherits all of Hono's routing, middleware, and context APIs. Adds route
 * discovery and registration on top. The typical lifecycle is:
 *
 * ```ts
 * const server = new Server()
 * await server.constructRoutes()
 * server.start()
 * ```
 */
export class Server extends Hono {
  /**
   * Binds the server to the `PORT` environment variable via `Bun.serve`.
   * Must be called after `constructRoutes` has registered all endpoints.
   */
  start() {
    Bun.serve({ fetch: this.fetch, port: env.PORT })
    console.log(`[Server] Listening on port ${env.PORT}`)
  }

  /**
   * Discovers and registers all route files with the Hono router.
   *
   * Calls the private `discoverRoutes` to load the route record, then iterates
   * each entry checking every HTTP method. When a route defines a handler for
   * a given method, a middleware chain is built and registered via
   * `this.on([method], [path], ...chain)`.
   */
  async constructRoutes() {
    const routes = await this.discoverRoutes()
    const limiter = new RateLimiter()

    // Other machines are turned away before anything else unless remote access is on
    this.use("*", requireLocal)

    for (const [path, route] of Object.entries(routes)) {
      for (const method of METHODS) {
        const key = method.toUpperCase() as HttpMethod
        const entry = route[key]
        if (!entry) continue

        const isConfig = typeof entry === "object" && "handler" in entry
        const handler = isConfig ? entry.handler : entry
        const bodySchema = isConfig ? entry.body : undefined
        const querySchema = isConfig ? entry.query : undefined

        // Throttle first, then authenticate, authorise and validate
        const authenticated = route.authenticated || route.admin
        const chain = [
          ...(route.rateLimit ? [limiter.forRoute(`${key} ${path}`, route.rateLimit)] : []),
          ...(authenticated ? [requireAuth] : []),
          ...(authenticated && !route.allowPendingReset ? [blockPendingReset] : []),
          ...(route.admin ? [requireAdmin] : []),
          ...(querySchema ? [validateQuery(querySchema)] : []),
          ...(bodySchema ? [validateBody(bodySchema)] : []),
          ...(route.middleware ?? []),
          handler,
        ]
        this.on([method], [path], ...chain)
      }
    }

    console.log(`[Server] Registered ${Object.keys(routes).length} routes`)
    await this.mountWebApp()
  }

  /**
   * Serves the web app at `/`.
   *
   * In production, serves the files the asset map embedded into the build —
   * next to the bundle, or inside a compiled executable — with an SPA fallback
   * to `index.html` for client-side routing. In development, proxies all
   * non-API requests to the Vite dev server so HMR works seamlessly.
   */
  private async mountWebApp() {
    // An API path no route claimed is a 404, never the web app. In dev the
    // proxy would otherwise hand it to Vite, whose `/api` proxy sends it
    // straight back here, looping until the request times out.
    this.all("/api/*", (c) => c.json({ error: "not_found" }, 404))

    if (process.env.NODE_ENV === "production") {
      const { assets } = await import("../../_asset.map")
      const web = new WebAssets(assets)

      this.get("*", (c) => web.serve(c))
      console.log(`[Server] Mounted web app (${Object.keys(assets).length} embedded files)`)
    } else {
      console.log("[Server] Mounted web app (dev proxy)")
      this.all("*", async (c) => {
        const url = new URL(c.req.url)
        url.port = "5173"
        const res = await fetch(url.toString(), {
          method: c.req.method,
          headers: c.req.raw.headers,
          body: c.req.raw.body,
        })
        return res
      })
    }
  }

  /**
   * Loads route definitions based on the current environment.
   *
   * In dev, scans `src/routes/` with `Bun.Glob` and dynamically imports every
   * `.ts` file. In prod, imports the static `_route.map.ts` generated by the
   * cartographer build script.
   */
  private async discoverRoutes(): Promise<Record<string, Route>> {
    if (process.env.NODE_ENV !== "production") {
      const glob = new Bun.Glob("**/*.ts")
      const dir = import.meta.dir + "/../../routes"
      const routes: Record<string, Route> = {}

      for await (const path of glob.scan(dir)) {
        const mod = await import(`../../routes/${path}`)
        routes[derivePath(path)] = mod.default
      }

      return routes
    }

    const map = await import("../../_route.map")
    return map.routes
  }
}
