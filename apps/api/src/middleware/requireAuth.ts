/**
 * Rejects requests without a valid BetterAuth session and stores the session
 * on the context for everything downstream.
 */

import type { MiddlewareHandler } from "hono";
import { auth } from "../lib/auth/client";

export const requireAuth: MiddlewareHandler = async (c, next) => {
  const session = await auth.api.getSession({ headers: c.req.raw.headers });

  if (!session) {
    return c.json({ error: "unauthorized" }, 401);
  }

  // Set session in context so further middleware and handlers can access it
  c.set("session", session);

  await next();
};
