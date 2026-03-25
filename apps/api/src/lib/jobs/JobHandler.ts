import { appendFile, mkdir } from "node:fs/promises";
import { join, isAbsolute } from "node:path";
import { eq, and, isNull } from "drizzle-orm";
import config from "../../config.json";
import { db } from "../db";
import { jobs } from "../db/schema/jobs";
import { indexes, torrents } from "../db/schema/indexes";
import type { JoblineCtx } from "../../types/Jobline";
import Jobline, { type LogLevel } from "./Jobline";

const LOG_DIR = config.paths.logs;

if (!isAbsolute(LOG_DIR)) {
  throw new Error(
    `config.paths.logs must be an absolute path, got: "${LOG_DIR}"`,
  );
}

export default class JobHandler {
  constructor(readonly jobId: string) {}

  private get logPath() {
    return join(LOG_DIR, `${this.jobId}.log`);
  }

  async run() {
    await this.log(`job-${this.jobId} started!`);

    // Pull row from db
    const job = await db.query.jobs.findFirst({
      where: eq(jobs.id, this.jobId),
    });
    if (!job) {
      const e = `Job ${this.jobId} not found`;
      await this.log(e, "error");
      throw new Error(e);
    }
    await this.log(`Job found in DB`);

    // create pipeline
    const pipeline = new Jobline();

    // Check last stage in pipeline
    switch (job.status.primary) {
      case "cancelled":
      case "completed":
      case "failed": {
        const e = `Job (${this.jobId}) already finished with status: ${job.status.primary}`;

        await this.log(e, "error");
        throw new Error(e);
      }

      case "pending":
      case "deciding":
      case "querying": {
        await this.log(`Starting pipeline from beginning`);

        // Run from start
        await pipeline.run({ job, log: this.log.bind(this) }, this.updateStatus.bind(this));
        break;
      }

      case "sterilizing": {
        await this.log(`Starting pipeline from sterilization`);

        const index = await db.query.indexes.findFirst({
          where: and(
            eq(indexes.imdbId, job.imdbId),
            job.season != null ? eq(indexes.season, job.season) : isNull(indexes.season),
            eq(indexes.userId, job.userId),
          ),
        });

        const topTorrent = index?.sourceId
          ? await db.query.torrents.findFirst({ where: eq(torrents.id, index.sourceId) })
          : undefined;

        const ctx: Partial<JoblineCtx> = { job, index, topTorrent, log: this.log.bind(this) };
        await pipeline.runFrom("sterilize", ctx as JoblineCtx, this.updateStatus.bind(this));
        break;
      }
    }

    await this.updateStatus("completed");
    await this.log(`Job completed`);
  }

  private async updateStatus(status: string) {
    // Update in db
    await db
      .update(jobs)
      .set({ status: { primary: status as any }, updatedAt: new Date() })
      .where(eq(jobs.id, this.jobId));
  }

  private async log(
    msg: string,
    level?: LogLevel,
    data?: Record<string, unknown>,
  ) {
    const line = `[${new Date().toISOString()}]-(${level ?? "info"}): ${msg}${data ? " " + JSON.stringify(data) : ""}\n`;

    await mkdir(LOG_DIR, { recursive: true });
    await appendFile(this.logPath, line);

    if (process.env.NODE_ENV !== "production") {
      const consoleFn = level === "error" ? console.error : level === "warn" ? console.warn : console.log;
      consoleFn(`[job:${this.jobId}] ${line.trimEnd()}`);
    }
  }
}
