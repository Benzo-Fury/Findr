/**
 * The download collection. `GET` lists downloads newest-first, paginated, and
 * optionally narrowed to active or finished ones. `POST` queues a movie or one
 * season of a show and answers 202 immediately — the work happens in the
 * background queue, and progress is read back from `GET /api/downloads/:id`.
 */

import {
  CreateDownloadRequestSchema,
  ListDownloadsQuerySchema,
  type DownloadSummary,
  type Paginated,
} from "@findr/types/downloads"
import { Download } from "../../lib/db/models/Download"
import DownloadQueue from "../../lib/pipeline/DownloadQueue"
import { factory } from "../../lib/routing/factory"
import { bodyOf, queryOf } from "../../lib/routing/input"
import { withQueue } from "../../lib/routing/queueErrors"

export default factory({
  GET: {
    query: ListDownloadsQuerySchema,
    handler: (c) => {
      const query = queryOf(c, ListDownloadsQuerySchema)
      const { items, total } = Download.list(query)

      const page: Paginated<DownloadSummary> = {
        items: items.map((download) => download.toSummary()),
        page: query.page,
        pageSize: query.pageSize,
        total,
      }
      return c.json(page)
    },
  },

  POST: {
    body: CreateDownloadRequestSchema,
    handler: (c) =>
      withQueue(c, () => {
        const body = bodyOf(c, CreateDownloadRequestSchema)
        const download = DownloadQueue.getInstance().enqueue(
          body.tmdbId,
          body.mediaType,
          body.season ?? null,
          c.get("session").user.id,
        )
        return c.json(download.toSummary(), 202)
      }),
  },
})
