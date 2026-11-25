/**
 * Starts playing a movie or episode. The body says what to play and what the
 * device can decode; the answer carries the playlist URL and how the file is
 * being sent (copied, audio converted, or transcoded, with the reasons).
 */

import { CreateSessionSchema } from "@findr/types/playback"
import { LocalNetwork } from "../../../lib/playback/LocalNetwork"
import PlaybackService, { PlaybackError } from "../../../lib/playback/PlaybackService"
import { requirePlayback } from "../../../lib/playback/requirePlayback"
import { factory } from "../../../lib/routing/factory"
import { bodyOf } from "../../../lib/routing/input"

export default factory({
  middleware: [requirePlayback],

  POST: {
    body: CreateSessionSchema,
    handler: async (c) => {
      try {
        const record = await PlaybackService.getInstance().create(bodyOf(c, CreateSessionSchema), {
          userId: c.get("session").user.id,
          local: LocalNetwork.includes(c),
        })
        return c.json(record, 201)
      } catch (error) {
        if (error instanceof PlaybackError) return c.json({ error: error.code }, error.status)
        throw error
      }
    },
  },
})
