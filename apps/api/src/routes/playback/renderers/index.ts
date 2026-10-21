/**
 * The DLNA renderers on the local network. A search runs when the last one
 * is more than half a minute old, or with `?refresh=1`.
 */

import { SettingsStore } from "../../../lib/db/models/SettingsStore"
import DlnaController from "../../../lib/playback/dlna/DlnaController"
import { requirePlayback } from "../../../lib/playback/requirePlayback"
import { factory } from "../../../lib/routing/factory"

export default factory({
  middleware: [requirePlayback],

  GET: async (c) => {
    if (!SettingsStore.section("playback").casting) return c.json({ error: "casting_disabled" }, 404)
    return c.json(await DlnaController.getInstance().list(c.req.query("refresh") === "1"))
  },
})
