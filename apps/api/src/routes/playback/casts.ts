/**
 * The TVs playing something the signed-in user started, so the web app can
 * show it and lead back to its remote after the remote is left. Empty while
 * casting is off; it never searches the network.
 */

import { SettingsStore } from "../../lib/db/models/SettingsStore"
import DlnaController from "../../lib/playback/dlna/DlnaController"
import { requirePlayback } from "../../lib/playback/requirePlayback"
import { factory } from "../../lib/routing/factory"

export default factory({
  middleware: [requirePlayback],

  GET: (c) => {
    if (!SettingsStore.section("playback").casting) return c.json([])
    return c.json(DlnaController.getInstance().castsOf(c.get("session").user.id))
  },
})
