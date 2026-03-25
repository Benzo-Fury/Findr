/**
 * Provides the `factory` function used by every route file to construct a
 * Route object with sensible defaults applied. This is the sole entry point
 * for route creation — route files should never build a raw Route literal
 * without passing it through `factory()`.
 *
 * Defaults are sourced from `config.json` at the project root. Any property
 * explicitly set on the incoming route takes precedence over the defaults
 * via shallow spread.
 */

import type { Route } from "../../types/Route"
import config from "../../config.json"

const defaults: Partial<Route> = {
  ...config.routeDefaults,
}

/**
 * Creates a fully-resolved Route by merging `config.json` defaults onto the
 * given partial route definition.
 *
 * Shallow-spreads `routeDefaults` first, then the caller's route on top, so
 * explicit values always win. Intended to be called at module scope in each
 * route file so the returned object is the file's default export.
 *
 * Takes a route-specific definition that must include at least one HTTP method
 * handler. Returns a complete Route with defaults filled in.
 *
 * ```ts
 * export default factory({
 *   GET: (c) => c.json({ status: "ok" }),
 * })
 * ```
 */
export function factory(route: Route): Route {
  return { ...defaults, ...route }
}
