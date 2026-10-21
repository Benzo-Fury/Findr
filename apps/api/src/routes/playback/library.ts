/**
 * Everything in the library that can be played, with the signed-in user's
 * progress on each item, what they are part-way through, and the next
 * episode of each show they are watching.
 */

import { WatchHistory } from "../../lib/playback/WatchHistory"
import { requirePlayback } from "../../lib/playback/requirePlayback"
import { factory } from "../../lib/routing/factory"

export default factory({
  middleware: [requirePlayback],

  GET: (c) => c.json(WatchHistory.library(c.get("session").user.id)),
})
