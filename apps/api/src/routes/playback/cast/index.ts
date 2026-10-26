/**
 * A Google Cast URL for another audio track or quality of what a receiver
 * is already casting. The player loads it on the receiver itself, so the
 * switch starts no browser session; the receiver's first request for it
 * replaces its old stream.
 */

import { CreateCastUrlSchema } from "@findr/types/playback"
import { LocalNetwork } from "../../../lib/playback/LocalNetwork"
import PlaybackService, { PlaybackError } from "../../../lib/playback/PlaybackService"
import { requirePlayback } from "../../../lib/playback/requirePlayback"
import { factory } from "../../../lib/routing/factory"
import { bodyOf } from "../../../lib/routing/input"

export default factory({
  middleware: [requirePlayback],

  POST: {
    body: CreateCastUrlSchema,
    handler: (c) => {
      try {
        const url = PlaybackService.getInstance().castUrl(bodyOf(c, CreateCastUrlSchema), {
          userId: c.get("session").user.id,
          local: LocalNetwork.includes(c),
        })
        return c.json({ url })
      } catch (error) {
        if (error instanceof PlaybackError) return c.json({ error: error.code }, error.status)
        throw error
      }
    },
  },
})
