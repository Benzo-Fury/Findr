/** Marks a movie or episode played or unplayed for the signed-in user. */

import { MarkPlayedSchema } from "@findr/types/playback"
import { WatchHistory } from "../../lib/playback/WatchHistory"
import { requirePlayback } from "../../lib/playback/requirePlayback"
import { factory } from "../../lib/routing/factory"
import { bodyOf } from "../../lib/routing/input"

export default factory({
  middleware: [requirePlayback],

  POST: {
    body: MarkPlayedSchema,
    handler: (c) => {
      const { played, ...key } = bodyOf(c, MarkPlayedSchema)
      WatchHistory.markPlayed(c.get("session").user.id, key, played)
      return c.body(null, 204)
    },
  },
})
