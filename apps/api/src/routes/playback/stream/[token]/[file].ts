/**
 * A session's media. For a browser or Cast session: `index.m3u8`,
 * `init.mp4` and `<n>.m4s`; for a DLNA session, its one stream. The signed
 * token in the path is the only credential, so players that send no cookies
 * — a TV — can fetch it too, and TVs on the local network may fetch it even
 * while remote access is off (`CastAccess`).
 */

import { MediaResponse } from "../../../../lib/playback/MediaResponse"
import PlaybackService from "../../../../lib/playback/PlaybackService"
import { StreamToken } from "../../../../lib/playback/StreamToken"
import { requirePlayback } from "../../../../lib/playback/requirePlayback"
import { factory } from "../../../../lib/routing/factory"

export default factory({
  authenticated: false,
  rateLimit: { max: 1200, window: 60 },
  middleware: [requirePlayback],

  OPTIONS: () => MediaResponse.preflight(),

  GET: async (c) => {
    const sessionId = StreamToken.verify(c.req.param("token") ?? "")
    const session = sessionId ? PlaybackService.getInstance().get(sessionId) : null
    if (!session) return MediaResponse.error("session_not_found", 404)

    const file = c.req.param("file") ?? ""
    return MediaResponse.isHls(session) ? MediaResponse.hls(c, session, file) : MediaResponse.progressive(c, session, file)
  },
})
