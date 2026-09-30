/**
 * One download. `GET` returns everything about it — episodes, every candidate
 * with its score or rejection reason, and the full attempt history. `DELETE`
 * cancels it if running and removes it with its history; files already saved
 * to the library are kept.
 */

import { Download } from "../../lib/db/models/Download"
import DownloadQueue from "../../lib/pipeline/DownloadQueue"
import { factory } from "../../lib/routing/factory"
import { withQueue } from "../../lib/routing/queueErrors"

export default factory({
  GET: (c) => {
    const download = Download.find(c.req.param("id") ?? "")
    if (!download) return c.json({ error: "not_found" }, 404)
    return c.json(download.toDetail())
  },

  DELETE: (c) =>
    withQueue(c, async () => {
      await DownloadQueue.getInstance().remove(c.req.param("id") ?? "")
      return c.body(null, 204)
    }),
})
