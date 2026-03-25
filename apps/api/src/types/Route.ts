/**
 * Defines the core route type used across the routing system. Each route file
 * in `src/routes/` exports a single Route object that declaratively describes
 * an endpoint — its auth requirements, middleware, and HTTP method handlers.
 * The route's path is derived from its file location within `src/routes/`.
 */

import type { Handler, MiddlewareHandler } from "hono"
import { METHODS } from "hono/router"
import type { ZodSchema } from "zod"

/**
 * Union of uppercase HTTP method strings derived from Hono's internal
 * `METHODS` constant (e.g. `"GET" | "POST" | "PUT" | ...`).
 */
export type HttpMethod = Uppercase<(typeof METHODS)[number]>

/**
 * Per-method configuration that bundles a handler with optional body
 * validation. When a method needs validation, wrap the handler in this
 * object instead of using a bare Handler.
 */
export type MethodConfig = {
  handler: Handler
  body?: ZodSchema
}

/**
 * A method entry on a Route — either a bare Hono Handler for simple cases,
 * or a MethodConfig object when the method needs its own body schema.
 */
export type MethodEntry = Handler | MethodConfig

/**
 * Declarative route descriptor consumed by `Server.constructRoutes`.
 *
 * Combines endpoint metadata (auth, rate limiting, middleware) with optional
 * HTTP method entries. Any key matching an HttpMethod is treated as a
 * MethodEntry for that verb. The route's path is derived from its file
 * location within `src/routes/` — it is not specified here.
 *
 * Defaults for `authenticated` and `rateLimit` are applied by `factory`
 * from `config.json` — only override what differs.
 */
export type Route = {
  authenticated?: boolean
  rateLimit?: { max: number; window: number }
  middleware?: MiddlewareHandler[]
} & {
  [M in HttpMethod]?: MethodEntry
}
