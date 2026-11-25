/**
 * The TVs on the server's network and its cast bridges', DLNA and Google Cast
 * alike. A search runs when the last one is more than half a minute old, or
 * with `?refresh=1`.
 */

import { SettingsStore } from "../../../lib/db/models/SettingsStore"
import { Renderers } from "../../../lib/playback/Renderers"
import { requirePlayback } from "../../../lib/playback/requirePlayback"
import { factory } from "../../../lib/routing/factory"

export default factory({
  middleware: [requirePlayback],

  GET: async (c) => {
    if (!SettingsStore.section("playback").casting) return c.json({ error: "casting_disabled" }, 404)
    return c.json(await Renderers.list(c.req.query("refresh") === "1"))
  },
})
