/**
 * Delegates all authentication endpoints to BetterAuth. Handles sign-up,
 * sign-in, session management, and any other auth operations under
 * `/auth/**`.
 *
 * Unauthenticated by design — these endpoints establish sessions, so they
 * cannot require one. BetterAuth applies its own stricter limits to sign-in;
 * the route limit here only caps overall volume, leaving room for the web
 * app's session checks. Sign-up is disabled in the auth config, and the admin
 * plugin's endpoints check the caller's role themselves.
 */

import { factory } from "../../lib/routing/factory"
import { methods } from "../../lib/routing/methods"
import { auth } from "../../lib/auth/client"

export default factory({
  authenticated: false,
  rateLimit: { max: 120, window: 60 },
  ...methods(["GET", "POST"], (c) => auth.handler(c.req.raw)),
})
