/**
 * Creates a middleware that parses and validates the request JSON body against
 * the given Zod schema. On success the parsed value is stored on context as
 * `"body"` so handlers can access it without re-parsing. On failure a 400 is
 * returned with the Zod issues.
 */

import type { MiddlewareHandler } from "hono"
import type { ZodType } from "zod"

export function validateBody(schema: ZodType): MiddlewareHandler {
  return async (c, next) => {
    let raw: unknown
    try {
      raw = await c.req.json()
    } catch {
      return c.json({ error: "invalid_json" }, 400)
    }
    const result = schema.safeParse(raw)
    if (!result.success) {
      return c.json({ error: "validation_failed", details: result.error.issues }, 400)
    }
    c.set("body", result.data)
    await next()
  }
}
