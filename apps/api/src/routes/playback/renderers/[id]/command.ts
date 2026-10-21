/** Play, pause, seek, stop or change the volume on a renderer Findr is driving. */

import { RendererCommandSchema } from "@findr/types/playback"
import { MediaResponse } from "../../../../lib/playback/MediaResponse"
import { PlaybackError } from "../../../../lib/playback/PlaybackService"
import DlnaController from "../../../../lib/playback/dlna/DlnaController"
import { requirePlayback } from "../../../../lib/playback/requirePlayback"
import { factory } from "../../../../lib/routing/factory"
import { bodyOf } from "../../../../lib/routing/input"

export default factory({
  middleware: [requirePlayback],

  POST: {
    body: RendererCommandSchema,
    handler: async (c) => {
      // The TV may take a while to load and start the stream
      MediaResponse.allowSlow(c, 60)
      try {
        const status = await DlnaController.getInstance().command(c.req.param("id") ?? "", bodyOf(c, RendererCommandSchema), c.get("session").user.id)
        return c.json(status)
      } catch (error) {
        if (error instanceof PlaybackError) return c.json({ error: error.code }, error.status)
        throw error
      }
    },
  },
})
