import type { MiddlewareHandler } from "hono"
import type { ZodSchema } from "zod"

/**
 * Creates a middleware that parses and validates the request JSON body against
 * the given Zod schema. On success the parsed value is stored on context as
 * `"body"` so handlers can access it type-safely without re-parsing. On
 * failure a 400 response is returned with the Zod error details.
 */
export function validateBody(schema: ZodSchema): MiddlewareHandler {
  return async (c, next) => {
    let raw: unknown
    try {
      raw = await c.req.json()
    } catch {
      return c.json({ error: "Invalid or missing JSON body" }, 400)
    }
    const result = schema.safeParse(raw)
    if (!result.success) {
      console.log(`[Validation] Body validation failed on ${c.req.method} ${c.req.path}: ${JSON.stringify(result.error.issues)}`)
      return c.json({ error: "Validation failed", details: result.error.issues }, 400)
    }
    c.set("body", result.data)
    await next()
  }
}
