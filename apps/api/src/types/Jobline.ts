import type { Torrent } from "@findr/adapters";
import type { indexes, torrents as dbTorrents } from "../lib/db/schema/indexes";
import type { jobs } from "../lib/db/schema/jobs";

export type LogLevel = "info" | "warn" | "error";

/** The context object that flows through every Jobline stage. Fields populated by stages are optional
 * so the pipeline can start with only the job and logger — earlier stages fill in the rest as they run. */
export type JoblineCtx = {
  job: typeof jobs.$inferSelect;
  log: (msg: string, level?: LogLevel, data?: Record<string, unknown>) => Promise<void>;
  /** Adapter-fetched torrent candidates, set by the query stage. */
  torrents?: Torrent[];
  /** Ranked adapter results, set by the decide stage. */
  scoredTorrents?: Array<{ torrent: Torrent; score: number }>;
  /** The persisted index record, set by the decide stage. */
  index?: typeof indexes.$inferSelect;
  /** The top-ranked persisted torrent, set by the decide stage (or provided on resume). */
  topTorrent?: typeof dbTorrents.$inferSelect;
  /** Host path containing the sterilized output files, set by the sterilize stage. */
  outputDir?: string;
};
