/**
 * Replaces the initial admin's `admin` / `admin` credentials with a real
 * email and password. Open only to an account flagged `mustReset`, which can
 * reach nothing else until this succeeds. Answers 204; the current session
 * stays signed in.
 */

import { CredentialsResetSchema } from "@findr/types/account"
import type { ContentfulStatusCode } from "hono/utils/http-status"
import { InitialCredentials, type ResetRefusal } from "../../lib/auth/InitialCredentials"
import { factory } from "../../lib/routing/factory"
import { bodyOf } from "../../lib/routing/input"

const STATUS: Record<ResetRefusal, ContentfulStatusCode> = {
  reset_not_required: 409,
  email_unchanged: 400,
  email_taken: 409,
}

export default factory({
  allowPendingReset: true,
  rateLimit: { max: 10, window: 60 },

  POST: {
    body: CredentialsResetSchema,
    handler: async (c) => {
      const refusal = await InitialCredentials.replace(c.get("session"), bodyOf(c, CredentialsResetSchema))
      if (refusal) return c.json({ error: refusal }, STATUS[refusal])
      return c.body(null, 204)
    },
  },
})
