/** Every session playing right now, for the admin's Now playing list. */

import PlaybackService from "../../../../lib/playback/PlaybackService"
import { requirePlayback } from "../../../../lib/playback/requirePlayback"
import { factory } from "../../../../lib/routing/factory"

export default factory({
  admin: true,
  middleware: [requirePlayback],

  GET: (c) => c.json(PlaybackService.getInstance().nowPlaying()),
})
