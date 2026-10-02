/**
 * Refuses an account that still has to replace its initial credentials. Runs
 * after `requireAuth`, which guarantees a session; routes that such an
 * account must still reach opt out with `allowPendingReset`.
 */

import type { MiddlewareHandler } from "hono";

export const blockPendingReset: MiddlewareHandler = async (c, next) => {
  if (c.get("session").user.mustReset) {
    return c.json({ error: "reset_required" }, 403);
  }

  await next();
};
