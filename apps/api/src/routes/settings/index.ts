/**
 * The settings store, for admins. `GET` returns the current settings with
 * defaults filled in; `PATCH` changes any subset of fields and returns the
 * result. Most changes apply to the next unit of work without a restart.
 *
 * API keys never leave the server: both methods answer with every secret
 * blanked, and say only which of them are set.
 */

import { SECRET_FIELDS, SettingsPatchSchema, type Settings, type SettingsResponse } from "@findr/types/settings"
import { SettingsStore } from "../../lib/db/models/SettingsStore"
import { factory } from "../../lib/routing/factory"
import { bodyOf } from "../../lib/routing/input"

/** The settings as the browser may see them. */
function response(settings: Settings): SettingsResponse {
  const services = { ...settings.services }
  const configured = {} as SettingsResponse["configured"]

  // Report each secret's presence, then blank it
  for (const field of SECRET_FIELDS) {
    configured[field] = services[field] !== ""
    services[field] = ""
  }

  return { settings: { ...settings, services }, configured }
}

export default factory({
  admin: true,

  GET: (c) => c.json(response(SettingsStore.load())),

  PATCH: {
    body: SettingsPatchSchema,
    handler: (c) => c.json(response(SettingsStore.update(bodyOf(c, SettingsPatchSchema)))),
  },
})
