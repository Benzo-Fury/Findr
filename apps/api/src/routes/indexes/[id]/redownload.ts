import { z } from "zod"
import { eq, and } from "drizzle-orm"
import { factory } from "../../../lib/routing/factory"
import { db } from "../../../lib/db"
import { indexes, torrents } from "../../../lib/db/schema/indexes"
import JobQueue from "../../../lib/jobs/JobQueue"

const redownloadSchema = z.object({
  torrentId: z.string().uuid(),
})

export default factory({
  authenticated: true,
  middleware: [],
  POST: {
    handler: async (ctx) => {
      const session = ctx.get("session") as { user: { id: string } }
      const indexId = ctx.req.param("id") as string
      const body = ctx.get("body") as z.infer<typeof redownloadSchema>

      const index = await db.query.indexes.findFirst({
        where: and(eq(indexes.id, indexId), eq(indexes.userId, session.user.id)),
      })

      if (!index) {
        return ctx.json({ error: "not_found" }, 404)
      }

      const torrent = await db.query.torrents.findFirst({
        where: and(eq(torrents.id, body.torrentId), eq(torrents.indexId, indexId)),
      })

      if (!torrent) {
        return ctx.json({ error: "torrent_not_found" }, 404)
      }

      await db
        .update(indexes)
        .set({ sourceId: body.torrentId })
        .where(eq(indexes.id, indexId))

      const queue = JobQueue.getInstance()
      const job = await queue.requeue(index.imdbId, index.season, index.userId)

      return ctx.json(job, 201)
    },
    body: redownloadSchema,
  },
})
