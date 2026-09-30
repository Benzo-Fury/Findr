/**
 * Provides the `factory` function used by every route file to construct a
 * Route object with sensible defaults applied. This is the sole entry point
 * for route creation — route files should never build a raw Route literal
 * without passing it through `factory()`.
 *
 * Any property explicitly set on the incoming route takes precedence over the
 * defaults via shallow spread.
 */

import type { Route } from "../../types/Route"

/**
 * Defaults every route starts from. These describe how the API is built rather
 * than anything a user tunes, so they live in code instead of the settings
 * store.
 */
export const ROUTE_DEFAULTS = {
  authenticated: false,
  rateLimit: { max: 60, window: 60 },
} as const satisfies Partial<Route>

/**
 * Creates a fully-resolved Route by merging the defaults onto the given
 * partial route definition.
 *
 * Shallow-spreads the defaults first, then the caller's route on top, so
 * explicit values always win. Intended to be called at module scope in each
 * route file so the returned object is the file's default export.
 *
 * ```ts
 * export default factory({
 *   GET: (c) => c.json({ status: "ok" }),
 * })
 * ```
 */
export function factory(route: Route): Route {
  return { ...ROUTE_DEFAULTS, ...route }
}
