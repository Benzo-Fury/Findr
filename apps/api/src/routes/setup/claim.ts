/**
 * Claiming a fresh install from another machine. `GET` says whether the
 * initial admin is still on `admin` / `admin`, and whether this request comes
 * from the server itself (where that login works). `POST` takes the setup
 * code from the server's log and the real email and password, replaces the
 * initial credentials with them and, for a request from elsewhere, turns on
 * remote access so the claimer can sign in. Answers 204; the client then
 * signs in as usual.
 *
 * Public, and reachable remotely only while the install is unclaimed
 * (`SetupCode`). The code has about 59 bits and the limit is tight, so it
 * cannot be guessed.
 */

import { SetupClaimSchema, type ClaimStatus } from "@findr/types/setup"
import type { ContentfulStatusCode } from "hono/utils/http-status"
import { InitialCredentials, type ResetRefusal } from "../../lib/auth/InitialCredentials"
import { SettingsStore } from "../../lib/db/models/SettingsStore"
import { factory } from "../../lib/routing/factory"
import { bodyOf } from "../../lib/routing/input"
import { ClientAddress } from "../../lib/server/ClientAddress"
import { SetupCode } from "../../lib/setup/SetupCode"

const STATUS: Record<ResetRefusal, ContentfulStatusCode> = {
  reset_not_required: 409,
  email_unchanged: 400,
  email_taken: 409,
  invalid_setup_code: 403,
}

export default factory({
  authenticated: false,
  rateLimit: { max: 10, window: 60 },

  GET: (c) => c.json<ClaimStatus>({ pending: SetupCode.pending, local: ClientAddress.isLocal(c) }),

  POST: {
    body: SetupClaimSchema,
    handler: async (c) => {
      const { code, ...credentials } = bodyOf(c, SetupClaimSchema)
      const refusal = await InitialCredentials.claim(code, credentials)
      if (refusal) return c.json({ error: refusal }, STATUS[refusal])

      // Whoever claimed from another machine has to be able to sign in from it
      if (!ClientAddress.isLocal(c)) SettingsStore.update({ access: { allowRemote: true } })
      return c.body(null, 204)
    },
  },
})
