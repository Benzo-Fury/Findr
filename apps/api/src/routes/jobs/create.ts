import { eq, and, isNull } from "drizzle-orm";
import { factory } from "../../lib/routing/factory";
import { db } from "../../lib/db";
import { jobs } from "../../lib/db/schema/jobs";
import { indexes } from "../../lib/db/schema/indexes";
import JobQueue, { jobParamsSchema, type JobParams } from "../../lib/jobs/JobQueue";

const TERMINAL_STATUSES = ["completed", "failed", "cancelled"] as const;

export default factory({
  authenticated: true,
  middleware: [],
  rateLimit: {
    // 1 request per minute
    max: 1,
    window: 1,
  },
  POST: {
    handler: async (ctx) => {
      const body = ctx.get("body") as JobParams;
      const session = ctx.get("session") as { user: { id: string } };
      const season = body.season ?? null;

      console.log(`[Jobs] Job requested for imdbId=${body.imdbId} season=${season} by user=${session.user.id}`);

      // Check if there is already an active (non-terminal) job for this item
      const activeJobs = await db
        .select()
        .from(jobs)
        .where(eq(jobs.imdbId, body.imdbId));

      const active = activeJobs.find(
        (job) =>
          !TERMINAL_STATUSES.includes(job.status.primary as any) &&
          job.season === season,
      );

      if (active) {
        console.log(`[Jobs] Active job exists: jobId=${active.id} for imdbId=${body.imdbId}`);
        return ctx.json(active, 200);
      }

      // Check if this content has already been indexed (global — one index per imdbId+season)
      const [existingIndex] = await db
        .select()
        .from(indexes)
        .where(
          and(
            eq(indexes.imdbId, body.imdbId),
            season !== null ? eq(indexes.season, season) : isNull(indexes.season),
          ),
        )
        .limit(1);

      if (existingIndex) {
        console.log(`[Jobs] Already indexed: imdbId=${body.imdbId} season=${season} indexId=${existingIndex.id}`);
        return ctx.json({ error: "already_indexed", index: existingIndex }, 409);
      }

      const queue = JobQueue.getInstance();
      const job = await queue.new(body, session.user.id);

      console.log(`[Jobs] Created job jobId=${job.id} for imdbId=${body.imdbId}`);
      return ctx.json(job, 201);
    },
    body: jobParamsSchema,
  },
});
