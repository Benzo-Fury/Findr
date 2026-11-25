/**
 * Types the values middleware stores on Hono's request context, so handlers
 * read them without casting through `any`.
 *
 * `body` and `query` are validated by their middleware against the route's
 * Zod schema but stored as `unknown` here, since one declaration serves every
 * route; `routing/input.ts` narrows them back to the route's schema type.
 */

import type { AuthSession } from "../lib/auth/client"
import type { CastBridge } from "../lib/db/models/CastBridge"

declare module "hono" {
  interface ContextVariableMap {
    session: AuthSession
    body: unknown
    query: unknown
    /** The cast bridge a connecting bridge's token belongs to. */
    castBridge: CastBridge
  }
}
