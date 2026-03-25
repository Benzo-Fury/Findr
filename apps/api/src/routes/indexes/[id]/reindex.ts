import { eq, and } from "drizzle-orm";
import { factory } from "../../../lib/routing/factory";
import { db } from "../../../lib/db";
import { indexes } from "../../../lib/db/schema/indexes";
import JobQueue from "../../../lib/jobs/JobQueue";

export default factory({
  authenticated: true,
  middleware: [],
  POST: async (ctx) => {
    const session = ctx.get("session") as { user: { id: string } };
    const indexId = ctx.req.param("id") as string;

    const index = await db.query.indexes.findFirst({
      where: and(eq(indexes.id, indexId), eq(indexes.userId, session.user.id)),
    });

    if (!index) {
      return ctx.json({ error: "not_found" }, 404);
    }

    await db.delete(indexes).where(eq(indexes.id, indexId));

    const queue = JobQueue.getInstance();
    const job = await queue.new(
      { imdbId: index.imdbId, season: index.season ?? undefined },
      session.user.id,
    );

    return ctx.json(job, 201);
  },
});
