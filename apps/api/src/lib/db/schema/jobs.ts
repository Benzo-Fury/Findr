/**
 * The `jobs` table: a queued or in-flight search for a piece of content.
 *
 * SQLite has no JSON or date type, so `status` and `preferences` are TEXT
 * holding serialised JSON, and timestamps are INTEGER holding Unix epoch
 * milliseconds. The row types below describe the values exactly as they come
 * out of the driver — turning them into objects and `Date`s is the model's job.
 */

/** Where a job currently is in the pipeline. */
export type JobStatus = {
  primary:
    | "pending"
    | "querying"
    | "deciding"
    | "sterilizing"
    | "saving"
    | "completed"
    | "failed"
    | "cancelled";
  message?: string;
};

/** A `jobs` row as stored: JSON columns unparsed, timestamps in epoch ms. */
export type JobRow = {
  id: string;
  imdb_id: string;
  season: number | null;
  /** Serialised `JobStatus`. */
  status: string;
  /** Serialised search preferences, or null when the defaults apply. */
  preferences: string | null;
  user_id: string;
  created_at: number;
  updated_at: number;
};

/** Statements that create the `jobs` table and its indexes. */
export const jobsSchema = [
  `CREATE TABLE IF NOT EXISTS jobs (
    id          TEXT PRIMARY KEY NOT NULL,
    imdb_id     TEXT NOT NULL,
    season      INTEGER,
    status      TEXT NOT NULL DEFAULT '{"primary":"pending"}',
    preferences TEXT,
    user_id     TEXT NOT NULL,
    created_at  INTEGER NOT NULL,
    updated_at  INTEGER NOT NULL,
    FOREIGN KEY (user_id) REFERENCES user(id)
  )`,
  `CREATE INDEX IF NOT EXISTS jobs_user_id_idx ON jobs (user_id)`,
];
