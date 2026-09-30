/**
 * Restricts a route to admins. Runs after `requireAuth`, which guarantees a
 * session is present; the role comes from BetterAuth's admin plugin.
 */

import type { MiddlewareHandler } from "hono";

export const requireAdmin: MiddlewareHandler = async (c, next) => {
  if (c.get("session").user.role !== "admin") {
    return c.json({ error: "forbidden" }, 403);
  }

  await next();
};
