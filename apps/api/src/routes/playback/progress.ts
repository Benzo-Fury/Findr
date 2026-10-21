/**
 * The player reporting where it is: every few seconds, and on pause, seek and
 * stop. The position is kept under the resume rules. A `stop` naming its
 * session also ends that session, so a closing tab frees its ffmpeg run at
 * once instead of waiting to be reaped.
 */

import { ReportProgressSchema } from "@findr/types/playback"
import PlaybackService from "../../lib/playback/PlaybackService"
import { PlaybackSession } from "../../lib/playback/PlaybackSession"
import { WatchHistory } from "../../lib/playback/WatchHistory"
import { requirePlayback } from "../../lib/playback/requirePlayback"
import { factory } from "../../lib/routing/factory"
import { bodyOf } from "../../lib/routing/input"

export default factory({
  middleware: [requirePlayback],

  POST: {
    body: ReportProgressSchema,
    handler: async (c) => {
      const report = bodyOf(c, ReportProgressSchema)
      const userId = c.get("session").user.id

      // Keep the session alive while its player reports, and remember its audio choice
      const service = PlaybackService.getInstance()
      const session = report.sessionId ? service.get(report.sessionId) : null
      const owned = session?.userId === userId ? session : null
      if (owned instanceof PlaybackSession) owned.report(report.positionMs)
      else owned?.touch()

      if (!WatchHistory.report(userId, report, owned?.audioLanguage ?? null)) return c.json({ error: "not_playable" }, 404)
      if (report.event === "stop" && report.sessionId) await service.end(report.sessionId, userId)
      return c.body(null, 204)
    },
  },
})
