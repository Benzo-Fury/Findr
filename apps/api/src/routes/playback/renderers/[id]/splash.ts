/** Shows or clears Findr's splash on a TV picked to cast to before anything plays. */

import { SettingsStore } from "../../../../lib/db/models/SettingsStore"
import { PlaybackError } from "../../../../lib/playback/PlaybackService"
import DlnaController from "../../../../lib/playback/dlna/DlnaController"
import { requirePlayback } from "../../../../lib/playback/requirePlayback"
import { factory } from "../../../../lib/routing/factory"

export default factory({
  middleware: [requirePlayback],

  POST: async (c) => {
    if (!SettingsStore.section("playback").casting) return c.json({ error: "casting_disabled" }, 404)
    try {
      await DlnaController.getInstance().showSplash(c.req.param("id") ?? "", c.get("session").user.id)
      return c.body(null, 204)
    } catch (error) {
      if (error instanceof PlaybackError) return c.json({ error: error.code }, error.status)
      throw error
    }
  },

  DELETE: async (c) => {
    await DlnaController.getInstance().hideSplash(c.req.param("id") ?? "", c.get("session").user.id)
    return c.body(null, 204)
  },
})
