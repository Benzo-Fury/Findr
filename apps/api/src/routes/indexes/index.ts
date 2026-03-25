import { eq, inArray } from "drizzle-orm"
import { factory } from "../../lib/routing/factory"
import { db } from "../../lib/db"
import { indexes, torrents } from "../../lib/db/schema/indexes"

export default factory({
  authenticated: true,
  middleware: [],
  GET: async (ctx) => {
    const session = ctx.get("session") as { user: { id: string } }

    const rows = await db
      .select()
      .from(indexes)
      .where(eq(indexes.userId, session.user.id))

    const indexTorrents = rows.length
      ? await db
          .select()
          .from(torrents)
          .where(inArray(torrents.indexId, rows.map((r) => r.id)))
      : []

    const torrentsByIndex = new Map<string, typeof indexTorrents>()
    for (const t of indexTorrents) {
      const list = torrentsByIndex.get(t.indexId) ?? []
      list.push(t)
      torrentsByIndex.set(t.indexId, list)
    }

    const result = rows.map((idx) => ({
      ...idx,
      torrents: (torrentsByIndex.get(idx.id) ?? []).sort((a, b) => b.score - a.score),
    }))

    return ctx.json(result, 200)
  },
})
