/**
 * Typed accessors for what the validation middleware stored on the context.
 * The schema argument exists only to carry the type: by the time a handler
 * runs, `validateBody` / `validateQuery` have already parsed the value with
 * that same schema, so narrowing it here is sound.
 */

import type { Context } from "hono"
import type { z, ZodType } from "zod"

/** The validated JSON body, typed by the route's body schema. */
export function bodyOf<S extends ZodType>(c: Context, _schema: S): z.infer<S> {
  return c.get("body") as z.infer<S>
}

/** The validated query string, typed by the route's query schema. */
export function queryOf<S extends ZodType>(c: Context, _schema: S): z.infer<S> {
  return c.get("query") as z.infer<S>
}
