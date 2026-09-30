/**
 * Cancels a download. Answers once it has actually stopped and cleaned up, so
 * the returned summary is final.
 */

import DownloadQueue from "../../../lib/pipeline/DownloadQueue"
import { factory } from "../../../lib/routing/factory"
import { withQueue } from "../../../lib/routing/queueErrors"

export default factory({
  POST: (c) =>
    withQueue(c, async () => {
      const download = await DownloadQueue.getInstance().cancel(c.req.param("id") ?? "")
      return c.json(download.toSummary())
    }),
})
