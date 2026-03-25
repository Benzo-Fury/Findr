import { eq, desc } from "drizzle-orm"
import { factory } from "../../lib/routing/factory"
import { db } from "../../lib/db"
import { jobs } from "../../lib/db/schema/jobs"

export default factory({
  authenticated: true,
  middleware: [],
  GET: async (ctx) => {
    const session = ctx.get("session") as { user: { id: string } }

    const rows = await db
      .select()
      .from(jobs)
      .where(eq(jobs.userId, session.user.id))
      .orderBy(desc(jobs.createdAt))
      .limit(50)

    return ctx.json(rows, 200)
  },
})
