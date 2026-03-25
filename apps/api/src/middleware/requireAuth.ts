import type { MiddlewareHandler } from "hono";
import { auth } from "../lib/auth/client";

export const requireAuth: MiddlewareHandler = async (c, next) => {
  const session = await auth.api.getSession({ headers: c.req.raw.headers });

  if (!session) {
    console.log(`[Auth] Unauthorized request to ${c.req.path}`);
    return c.json({ error: "Unauthorized" }, 401);
  }

  // Set session in context so further middleware can access
  c.set("session", session);

  await next();
};
