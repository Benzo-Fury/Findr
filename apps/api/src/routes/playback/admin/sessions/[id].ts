/** Stops anyone's session, including the TV it plays on. */

import PlaybackService from "../../../../lib/playback/PlaybackService"
import { requirePlayback } from "../../../../lib/playback/requirePlayback"
import { factory } from "../../../../lib/routing/factory"

export default factory({
  admin: true,
  middleware: [requirePlayback],

  DELETE: async (c) => {
    const ended = await PlaybackService.getInstance().end(c.req.param("id") ?? "", null)
    return ended ? c.body(null, 204) : c.json({ error: "session_not_found" }, 404)
  },
})
