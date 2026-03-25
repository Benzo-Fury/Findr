import { z } from "zod";
import { eq } from "drizzle-orm";
import { defaultPreferences, jobDefaults } from "@findr/config";
import SelfManagedSingleton from "../other/SelfManagedSingleton";
import { db } from "../db";
import { jobs } from "../db/schema/jobs";
import JobHandler from "./JobHandler";

export type Job = typeof jobs.$inferSelect;

export const jobParamsSchema = z.object({
  imdbId: z.string(),
  season: z.number().optional(),
  preferences: z
    .object({
      resolutions: z.array(z.string()).default(defaultPreferences.resolutions),
      maxFileSizeGB: z.number().default(defaultPreferences.maxFileSizeGB),
      minSeeders: z.number().default(defaultPreferences.minSeeders),
      blacklistedReleaseTypes: z
        .array(z.string())
        .default(defaultPreferences.blacklistedReleaseTypes),
    })
    .optional(),
});

export type JobParams = z.infer<typeof jobParamsSchema>;

/** Terminal statuses that indicate a job is no longer active. */
const TERMINAL_STATUSES = ["completed", "failed", "cancelled"] as const;

/**
 * Singleton that owns the lifecycle of every job in the system.
 *
 * Jobs are persisted to the database immediately on creation and held
 * in an in-memory queue. A concurrency limit (configurable via
 * `@findr/config`) controls how many JobHandlers run in parallel —
 * any excess jobs wait in the queue until a slot frees up.
 *
 * The queue does not manage individual job status; each JobHandler
 * is responsible for advancing its own status through the pipeline.
 * On startup, non-terminal jobs are reloaded from the database so
 * work resumes automatically after a restart.
 */
export default class JobQueue extends SelfManagedSingleton {
  private queue: string[] = [];
  private running = new Set<string>();
  private maxConcurrent = jobDefaults.maxConcurrentJobs;

  /**
   * Use JobQueue.getInstance() to create a new instance of the JobQueue.
   */
constructor() {
    super();
    this.loadPendingJobs();
  }

  /**
   * Registers a new job, persists it to the database, and enqueues it
   * for processing. Callers are responsible for checking duplicates
   * before calling this.
   */
  async new(params: JobParams, userId: string): Promise<Job> {
    const job = await this.createJob(params, userId);
    this.drain();
    return job;
  }

  /**
   * Creates a sterilize-only job for already-indexed content, skipping the
   * query and decide stages. Used when re-downloading with a different torrent.
   * The caller is responsible for updating the index's sourceId first.
   */
  async requeue(imdbId: string, season: number | null, userId: string): Promise<Job> {
    const [job] = await db
      .insert(jobs)
      .values({
        imdbId,
        season: season ?? undefined,
        userId,
        status: { primary: "sterilizing" },
      })
      .returning();

    this.queue.push(job.id);
    console.log(`[Queue] Requeued sterilize job jobId=${job.id} for imdbId=${imdbId} (queue: ${this.queue.length}, running: ${this.running.size})`);
    this.drain();
    return job;
  }

  /**
   * Processes queued jobs up to the concurrency limit. Each job is handed
   * to a new JobHandler; when it finishes, the slot is freed and the next
   * queued job is dispatched.
   */
  private drain() {
    if (this.running.size >= this.maxConcurrent && this.queue.length > 0) {
      console.log(`[Queue] At capacity (${this.running.size}/${this.maxConcurrent}), ${this.queue.length} waiting`);
    }

    while (this.running.size < this.maxConcurrent && this.queue.length > 0) {
      const jobId = this.queue.shift()!;
      this.running.add(jobId);

      console.log(`[Queue] Starting job jobId=${jobId} (running: ${this.running.size}/${this.maxConcurrent})`);

      const handler = new JobHandler(jobId);
      handler.run()
        .catch((err) => {
          console.error(`[Queue] Job jobId=${jobId} failed: ${err?.message ?? err}`);
          return db.update(jobs).set({ status: { primary: "failed", message: err?.message }, updatedAt: new Date() }).where(eq(jobs.id, jobId));
        })
        .finally(() => {
          this.running.delete(jobId);
          console.log(`[Queue] Job jobId=${jobId} finished (running: ${this.running.size}/${this.maxConcurrent}, queue: ${this.queue.length})`);
          this.drain();
        });
    }
  }

  /** Loads any non-terminal jobs from the database into the queue on startup. */
  private async loadPendingJobs() {
    const rows = await db.select().from(jobs);

    this.queue = rows
      .filter((job) => !TERMINAL_STATUSES.includes(job.status.primary as any))
      .map((job) => job.id);

    console.log(`[Queue] Loaded ${this.queue.length} pending jobs from database`);
    this.drain();
  }

  /** Inserts a new job into the database and appends it to the queue. */
  private async createJob(params: JobParams, userId: string): Promise<Job> {
    const [job] = await db
      .insert(jobs)
      .values({
        imdbId: params.imdbId,
        season: params.season,
        preferences: params.preferences,
        userId,
      })
      .returning();

    this.queue.push(job.id);
    console.log(`[Queue] Enqueued job jobId=${job.id} (queue: ${this.queue.length}, running: ${this.running.size})`);
    return job;
  }
}
