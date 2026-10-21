/** Plays a movie or episode on a DLNA renderer; Findr becomes its remote. */

import { RendererPlaySchema } from "@findr/types/playback"
import { SettingsStore } from "../../../../lib/db/models/SettingsStore"
import { MediaResponse } from "../../../../lib/playback/MediaResponse"
import { PlaybackError } from "../../../../lib/playback/PlaybackService"
import DlnaController from "../../../../lib/playback/dlna/DlnaController"
import { requirePlayback } from "../../../../lib/playback/requirePlayback"
import { factory } from "../../../../lib/routing/factory"
import { bodyOf } from "../../../../lib/routing/input"

export default factory({
  middleware: [requirePlayback],

  POST: {
    body: RendererPlaySchema,
    handler: async (c) => {
      if (!SettingsStore.section("playback").casting) return c.json({ error: "casting_disabled" }, 404)
      // The TV may take a while to load and start the stream
      MediaResponse.allowSlow(c, 60)
      try {
        const status = await DlnaController.getInstance().play(c.req.param("id") ?? "", bodyOf(c, RendererPlaySchema), c.get("session").user.id)
        return c.json(status)
      } catch (error) {
        if (error instanceof PlaybackError) {
          if (error.status === 502) console.warn(`[Playback] DLNA play failed: ${error.message}`)
          return c.json({ error: error.code }, error.status)
        }
        throw error
      }
    },
  },
})
