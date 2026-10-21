/** Ends one of the signed-in user's playback sessions, stopping its ffmpeg run. */

import PlaybackService from "../../../lib/playback/PlaybackService"
import { requirePlayback } from "../../../lib/playback/requirePlayback"
import { factory } from "../../../lib/routing/factory"

export default factory({
  middleware: [requirePlayback],

  DELETE: async (c) => {
    const ended = await PlaybackService.getInstance().end(c.req.param("id") ?? "", c.get("session").user.id)
    return ended ? c.body(null, 204) : c.json({ error: "not_found" }, 404)
  },
})
