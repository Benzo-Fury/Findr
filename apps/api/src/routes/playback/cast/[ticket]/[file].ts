/**
 * Media for a Google Cast receiver. The ticket in the path names what to
 * play and who cast it; the receiver's first request turns it into a session
 * sized for a TV, and its later requests share that session. Like the stream
 * route, the path is the only credential.
 */

import { CastTicket } from "../../../../lib/playback/CastTicket"
import { MediaResponse } from "../../../../lib/playback/MediaResponse"
import PlaybackService, { PlaybackError } from "../../../../lib/playback/PlaybackService"
import { requirePlayback } from "../../../../lib/playback/requirePlayback"
import { factory } from "../../../../lib/routing/factory"

export default factory({
  authenticated: false,
  rateLimit: { max: 1200, window: 60 },
  middleware: [requirePlayback],

  OPTIONS: () => MediaResponse.preflight(),

  GET: async (c) => {
    const ticket = c.req.param("ticket") ?? ""
    const data = CastTicket.verify(ticket)
    if (!data) return MediaResponse.error("session_not_found", 404)

    try {
      const session = await PlaybackService.getInstance().castSession(ticket, data)
      return await MediaResponse.hls(c, session, c.req.param("file") ?? "")
    } catch (error) {
      if (error instanceof PlaybackError) return MediaResponse.error(error.code, error.status === 404 ? 404 : 503)
      throw error
    }
  },
})
