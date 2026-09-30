import type { Torrent } from "@findr/adapters";
import type { IndexRow, TorrentRow } from "../lib/db/schema/indexes";
import type { JobRow } from "../lib/db/schema/jobs";

export type LogLevel = "info" | "warn" | "error";

/** The context object that flows through every Jobline stage. Fields populated by stages are optional
 * so the pipeline can start with only the job and logger — earlier stages fill in the rest as they run. */
export type JoblineCtx = {
  job: JobRow;
  log: (msg: string, level?: LogLevel, data?: Record<string, unknown>) => Promise<void>;
  /** Adapter-fetched torrent candidates, set by the query stage. */
  torrents?: Torrent[];
  /** Ranked adapter results, set by the decide stage. */
  scoredTorrents?: Array<{ torrent: Torrent; score: number }>;
  /** The persisted index record, set by the decide stage. */
  index?: IndexRow;
  /** The top-ranked persisted torrent, set by the decide stage (or provided on resume). */
  topTorrent?: TorrentRow;
  /** Host path containing the sterilized output files, set by the sterilize stage. */
  outputDir?: string;
};
