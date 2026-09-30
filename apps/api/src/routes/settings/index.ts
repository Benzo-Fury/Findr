/**
 * The settings store, for admins. `GET` returns the current settings with
 * defaults filled in; `PATCH` changes any subset of fields and returns the
 * result. Changes apply to the next unit of work — no restart needed.
 */

import { SettingsPatchSchema, type SettingsResponse } from "@findr/types/settings"
import { SettingsStore } from "../../lib/db/models/SettingsStore"
import { env } from "../../lib/env/Env"
import { factory } from "../../lib/routing/factory"
import { bodyOf } from "../../lib/routing/input"

/** Settings plus the server capabilities the settings page needs to know about. */
function response(): SettingsResponse {
  return { settings: SettingsStore.load(), llmAvailable: Boolean(env.ANTHROPIC_API_KEY) }
}

export default factory({
  admin: true,

  GET: (c) => c.json(response()),

  PATCH: {
    body: SettingsPatchSchema,
    handler: (c) => {
      SettingsStore.update(bodyOf(c, SettingsPatchSchema))
      return c.json(response())
    },
  },
})
