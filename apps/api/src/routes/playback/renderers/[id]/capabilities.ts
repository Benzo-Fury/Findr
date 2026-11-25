/** An admin's corrections to what a TV plays: HEVC, 4K and HDR, each left to the TV when null. */

import { RendererOverridesSchema } from "@findr/types/playback"
import { PlaybackError } from "../../../../lib/playback/PlaybackService"
import DlnaController from "../../../../lib/playback/dlna/DlnaController"
import { requirePlayback } from "../../../../lib/playback/requirePlayback"
import { factory } from "../../../../lib/routing/factory"
import { bodyOf } from "../../../../lib/routing/input"

export default factory({
  admin: true,
  middleware: [requirePlayback],

  PUT: {
    body: RendererOverridesSchema,
    handler: (c) => {
      try {
        return c.json(DlnaController.getInstance().setOverrides(c.req.param("id") ?? "", bodyOf(c, RendererOverridesSchema)))
      } catch (error) {
        if (error instanceof PlaybackError) return c.json({ error: error.code }, error.status)
        throw error
      }
    },
  },
})
