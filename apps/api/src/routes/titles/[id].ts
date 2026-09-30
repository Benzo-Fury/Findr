/**
 * One requested title. `GET` returns it with all of its downloads. `DELETE`
 * forgets it: running downloads are cancelled and every download is removed
 * with its history. Files already saved to the library are kept.
 */

import { Download } from "../../lib/db/models/Download"
import { Title } from "../../lib/db/models/Title"
import DownloadQueue from "../../lib/pipeline/DownloadQueue"
import { factory } from "../../lib/routing/factory"
import { withQueue } from "../../lib/routing/queueErrors"

export default factory({
  GET: (c) => {
    const title = Title.find(c.req.param("id") ?? "")
    if (!title) return c.json({ error: "not_found" }, 404)

    const downloads = Download.forTitles([title.id]).get(title.id) ?? []
    return c.json(title.toSummary(downloads.map((download) => download.toSummary())))
  },

  DELETE: (c) =>
    withQueue(c, async () => {
      const title = Title.find(c.req.param("id") ?? "")
      if (!title) return c.json({ error: "not_found" }, 404)

      // Stop and remove each download first so running work is cleaned up
      const queue = DownloadQueue.getInstance()
      for (const download of Download.forTitles([title.id]).get(title.id) ?? []) {
        await queue.remove(download.id)
      }
      title.delete()
      return c.body(null, 204)
    }),
})
