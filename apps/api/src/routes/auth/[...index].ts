/**
 * Delegates all authentication endpoints to BetterAuth. Handles sign-up,
 * sign-in, session management, and any other auth operations under
 * `/auth/**`.
 *
 * Unauthenticated by design — these endpoints establish sessions, so they
 * cannot require one.
 */

import { factory } from "../../lib/routing/factory"
import { methods } from "../../lib/routing/methods"
import { auth } from "../../lib/auth/client"

export default factory({
  authenticated: false,
  ...methods(["GET", "POST"], (c) => auth.handler(c.req.raw)),
})
