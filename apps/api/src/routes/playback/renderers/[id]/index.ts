/** What a DLNA renderer Findr knows of is doing: what it plays, where, and its volume. */

import { PlaybackError } from "../../../../lib/playback/PlaybackService"
import { Renderers } from "../../../../lib/playback/Renderers"
import { requirePlayback } from "../../../../lib/playback/requirePlayback"
import { factory } from "../../../../lib/routing/factory"

export default factory({
  middleware: [requirePlayback],

  GET: (c) => {
    try {
      return c.json(Renderers.of(c.req.param("id") ?? "").status(c.req.param("id") ?? "", c.get("session").user.id))
    } catch (error) {
      if (error instanceof PlaybackError) return c.json({ error: error.code }, error.status)
      throw error
    }
  },
})
