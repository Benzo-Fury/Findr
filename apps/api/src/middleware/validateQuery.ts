/**
 * Validates a request's query string against a Zod schema — the query-string
 * counterpart to `validateBody`. The parsed value, with coercions and
 * defaults applied, is stored on the context as `"query"`.
 */

import type { MiddlewareHandler } from "hono"
import type { ZodType } from "zod"

export function validateQuery(schema: ZodType): MiddlewareHandler {
  return async (c, next) => {
    const result = schema.safeParse(c.req.query())
    if (!result.success) {
      return c.json({ error: "validation_failed", details: result.error.issues }, 400)
    }
    c.set("query", result.data)
    await next()
  }
}
