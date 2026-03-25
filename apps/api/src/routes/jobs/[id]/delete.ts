import { eq, and } from "drizzle-orm";
import { factory } from "../../../lib/routing/factory";
import { db } from "../../../lib/db";
import { jobs } from "../../../lib/db/schema/jobs";

export default factory({
  authenticated: true,
  middleware: [],
  DELETE: async (ctx) => {
    const session = ctx.get("session") as { user: { id: string } };
    const jobId = ctx.req.param("id") as string;

    const job = await db.query.jobs.findFirst({
      where: and(eq(jobs.id, jobId), eq(jobs.userId, session.user.id)),
    });

    if (!job) {
      return ctx.json({ error: "not_found" }, 404);
    }

    await db.delete(jobs).where(eq(jobs.id, jobId));

    return ctx.body(null, 204);
  },
});
