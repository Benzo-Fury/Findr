/** The signed-in user's playback preferences: audio language and autoplay. */

import { PlaybackPrefsSchema } from "@findr/types/playback"
import { PlaybackPrefs } from "../../lib/db/models/PlaybackPrefs"
import { requirePlayback } from "../../lib/playback/requirePlayback"
import { factory } from "../../lib/routing/factory"
import { bodyOf } from "../../lib/routing/input"

export default factory({
  middleware: [requirePlayback],

  GET: (c) => c.json(PlaybackPrefs.get(c.get("session").user.id)),

  PUT: {
    body: PlaybackPrefsSchema,
    handler: (c) => c.json(PlaybackPrefs.set(c.get("session").user.id, bodyOf(c, PlaybackPrefsSchema))),
  },
})
