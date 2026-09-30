/**
 * Starts a finished download again as a new run. With a `candidateId`, that
 * release is tried first — the way to pick a specific torrent by hand.
 * Answers 202; the run happens in the background.
 */

import { RetryDownloadRequestSchema } from "@findr/types/downloads"
import DownloadQueue from "../../../lib/pipeline/DownloadQueue"
import { factory } from "../../../lib/routing/factory"
import { bodyOf } from "../../../lib/routing/input"
import { withQueue } from "../../../lib/routing/queueErrors"

export default factory({
  POST: {
    body: RetryDownloadRequestSchema,
    handler: (c) =>
      withQueue(c, () => {
        const { candidateId } = bodyOf(c, RetryDownloadRequestSchema)
        const download = DownloadQueue.getInstance().retry(c.req.param("id") ?? "", candidateId)
        return c.json(download.toSummary(), 202)
      }),
  },
})
