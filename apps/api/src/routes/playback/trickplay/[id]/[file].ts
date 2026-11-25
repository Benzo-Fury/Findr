/**
 * A media item's scrubbing thumbnails: `storyboard.vtt` and the sprite
 * sheets it points into. Only the browser's player asks for these, with its
 * session cookie.
 */

import { join } from "node:path"
import { Trickplay } from "../../../../lib/playback/Trickplay"
import { requirePlayback } from "../../../../lib/playback/requirePlayback"
import { factory } from "../../../../lib/routing/factory"

export default factory({
  rateLimit: { max: 1200, window: 60 },
  middleware: [requirePlayback],

  GET: async (c) => {
    const id = c.req.param("id") ?? ""
    const file = c.req.param("file") ?? ""
    const directory = /^[\w-]+$/.test(id) ? Trickplay.directory(id) : null
    const type = file === "storyboard.vtt" ? "text/vtt" : /^\d+\.jpg$/.test(file) ? "image/jpeg" : null
    if (!directory || !type) return c.json({ error: "not_found" }, 404)

    const content = Bun.file(join(directory, file))
    if (!(await content.exists())) return c.json({ error: "not_found" }, 404)
    // The storyboard's URL carries its version; sheets are replaced with it, so they are checked each time
    return new Response(content, { headers: { "Content-Type": type, "Cache-Control": "private, no-cache" } })
  },
})
