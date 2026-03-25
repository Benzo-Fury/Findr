/**
 * Convenience helper for assigning the same Hono handler to multiple HTTP
 * methods on a Route. Returns a partial Route object that can be spread
 * into a `factory()` call.
 *
 * Without this, routes that handle several verbs identically must repeat
 * the handler for each one. This is common with catch-all proxy routes
 * like BetterAuth, where GET and POST both delegate to the same handler.
 *
 * ```ts
 * export default factory({
 *   ...methods(["GET", "POST"], (c) => auth.handler(c.req.raw)),
 * })
 * ```
 */

import type { HttpMethod, MethodEntry, Route } from "../../types/Route"

export function methods(
  verbs: HttpMethod[],
  handler: MethodEntry,
): Partial<Route> {
  return Object.fromEntries(verbs.map((m) => [m, handler]))
}
