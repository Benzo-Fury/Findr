/**
 * Read-only aggregates across the pipeline, library and playback tables for
 * the Admin page. Each query returns the narrowest rows the figures need;
 * `AdminStats` turns them into the page's numbers.
 */

import type { MediaType } from "@findr/types/media";
import type { AttemptTimings } from "./Attempt";
import type { CreditsSource } from "./MediaItem";
import { Model } from "./Model";

// ---------- Rows ---------- //

/** A download that reached a final status. */
export interface FinishedDownloadRow {
  status: "completed" | "partial" | "failed" | "cancelled";
  createdAt: number;
  updatedAt: number;
}

/** A release that reached the library, with how its attempt was timed. */
export interface TimedAttemptRow {
  finishedAt: number;
  bytes: number | null;
  timings: AttemptTimings;
  indexer: string;
}

/** A release Findr tried, with whether any try of it reached the library. */
export interface TriedReleaseRow {
  indexer: string;
  sizeMB: number;
  worked: boolean;
}

/** A library file with what the Admin page reads about it. */
export interface LibraryFileRow {
  titleId: string;
  tmdbId: number;
  mediaType: MediaType;
  episode: number | null;
  size: number;
  durationMs: number;
  probe: string;
  creditsMs: number | null;
  creditsSource: CreditsSource | null;
  /** When the file was written, in epoch milliseconds. */
  mtime: number;
}

/** One user's progress through one film or episode. */
export interface WatchRow {
  userId: string;
  titleId: string;
  tmdbId: number;
  mediaType: MediaType;
  watchedMs: number;
}

/** An account. */
export interface AccountRow {
  id: string;
  name: string;
  email: string;
  role: string | null;
}

// ---------- Model ---------- //

export class Analytics extends Model {
  /** Downloads asked for since `since`. */
  public static requestedSince(since: number): number {
    return this.db.query<{ total: number }, { since: number }>("SELECT COUNT(*) AS total FROM downloads WHERE created_at >= $since").get({ since })?.total ?? 0;
  }

  /** Downloads waiting their turn, and those searching or downloading now. */
  public static activeDownloads(): { queued: number; running: number } {
    const row = this.db
      .query<{ queued: number | null; running: number | null }, []>(
        `SELECT SUM(status = 'queued') AS queued, SUM(status IN ('searching', 'downloading')) AS running
         FROM downloads WHERE status IN ('queued', 'searching', 'downloading')`,
      )
      .get();
    return { queued: row?.queued ?? 0, running: row?.running ?? 0 };
  }

  /** Downloads asked for since `since`, by who asked. */
  public static requestsByUser(since: number): Map<string, number> {
    const rows = this.db
      .query<{ user: string; total: number }, { since: number }>(
        "SELECT requested_by AS user, COUNT(*) AS total FROM downloads WHERE created_at >= $since AND requested_by IS NOT NULL GROUP BY requested_by",
      )
      .all({ since });
    return new Map(rows.map((row) => [row.user, row.total]));
  }

  /** Downloads that finished since `since`, whatever the outcome. */
  public static finishedDownloads(since: number): FinishedDownloadRow[] {
    return this.db
      .query<{ status: FinishedDownloadRow["status"]; created_at: number; updated_at: number }, { since: number }>(
        `SELECT status, created_at, updated_at FROM downloads
         WHERE status IN ('completed', 'partial', 'failed', 'cancelled') AND updated_at >= $since`,
      )
      .all({ since })
      .map((row) => ({ status: row.status, createdAt: row.created_at, updatedAt: row.updated_at }));
  }

  /** Successful attempts since `since` that recorded how long each step took. */
  public static timedAttempts(since: number): TimedAttemptRow[] {
    return this.db
      .query<{ finished_at: number; bytes: number | null; timings: string; indexer: string }, { since: number }>(
        `SELECT a.finished_at, a.bytes, a.timings, c.indexer FROM attempts a
         JOIN candidates c ON c.id = a.candidate_id
         WHERE a.outcome = 'succeeded' AND a.finished_at >= $since AND a.timings IS NOT NULL`,
      )
      .all({ since })
      .map((row) => ({ finishedAt: row.finished_at, bytes: row.bytes, timings: JSON.parse(row.timings) as AttemptTimings, indexer: row.indexer }));
  }

  /**
   * For each attempt that succeeded since `since`, how many releases its unit
   * (a movie, a season pack or an episode) tried in that run, the successful
   * one included. Interrupted and cancelled tries aren't the release's doing
   * and don't count.
   */
  public static releasesTried(since: number): number[] {
    return this.db
      .query<{ tries: number }, { since: number }>(
        `SELECT (
           SELECT COUNT(*) FROM attempts b
           WHERE b.download_id = a.download_id AND b.episode_id IS a.episode_id AND b.run = a.run
             AND b.outcome IN ('succeeded', 'failed') AND b.started_at <= a.started_at
         ) AS tries
         FROM attempts a WHERE a.outcome = 'succeeded' AND a.finished_at >= $since`,
      )
      .all({ since })
      .map((row) => row.tries);
  }

  /** Why each release that failed since `since` was given up on. */
  public static failureReasons(since: number): string[] {
    return this.db
      .query<{ reason: string | null }, { since: number }>("SELECT reason FROM attempts WHERE outcome = 'failed' AND finished_at >= $since")
      .all({ since })
      .map((row) => row.reason ?? "");
  }

  /** Releases each indexer returned to searches since `since`. */
  public static releasesFound(since: number): Map<string, number> {
    const rows = this.db
      .query<{ indexer: string; total: number }, { since: number }>(
        "SELECT indexer, COUNT(*) AS total FROM candidates WHERE created_at >= $since GROUP BY indexer",
      )
      .all({ since });
    return new Map(rows.map((row) => [row.indexer, row.total]));
  }

  /** Every release tried since `since` that ran to an outcome of its own. */
  public static releasesTriedByIndexer(since: number): TriedReleaseRow[] {
    return this.db
      .query<{ indexer: string; size_mb: number; worked: number }, { since: number }>(
        `SELECT c.indexer, c.size_mb, MAX(a.outcome = 'succeeded') AS worked FROM attempts a
         JOIN candidates c ON c.id = a.candidate_id
         WHERE a.started_at >= $since AND a.outcome IN ('succeeded', 'failed')
         GROUP BY a.candidate_id`,
      )
      .all({ since })
      .map((row) => ({ indexer: row.indexer, sizeMB: row.size_mb, worked: row.worked === 1 }));
  }

  /** Every file in the library. */
  public static libraryFiles(): LibraryFileRow[] {
    return this.db
      .query<
        {
          title_id: string;
          tmdb_id: number;
          media_type: MediaType;
          episode: number | null;
          size: number;
          duration_ms: number;
          probe: string;
          credits_ms: number | null;
          credits_source: CreditsSource | null;
          mtime: number;
        },
        []
      >(
        `SELECT m.title_id, t.tmdb_id, t.media_type, m.episode, m.size, m.duration_ms, m.probe, m.credits_ms, m.credits_source, m.mtime
         FROM media_items m JOIN titles t ON t.id = m.title_id`,
      )
      .all()
      .map((row) => ({
        titleId: row.title_id,
        tmdbId: row.tmdb_id,
        mediaType: row.media_type,
        episode: row.episode,
        size: row.size,
        durationMs: row.duration_ms,
        probe: row.probe,
        creditsMs: row.credits_ms,
        creditsSource: row.credits_source,
        mtime: row.mtime,
      }));
  }

  /**
   * Films and episodes someone watched since `since`, with how much of each:
   * the whole length once finished, else as far as they got.
   */
  public static watched(since: number): WatchRow[] {
    return this.db
      .query<{ user_id: string; title_id: string; tmdb_id: number; media_type: MediaType; watched_ms: number }, { since: number }>(
        `SELECT p.user_id, p.title_id, t.tmdb_id, t.media_type,
           CASE WHEN p.played = 1 THEN MAX(p.duration_ms, p.position_ms) ELSE p.position_ms END AS watched_ms
         FROM playback_progress p JOIN titles t ON t.id = p.title_id
         WHERE p.last_played_at >= $since AND (p.played = 1 OR p.position_ms > 0)`,
      )
      .all({ since })
      .map((row) => ({ userId: row.user_id, titleId: row.title_id, tmdbId: row.tmdb_id, mediaType: row.media_type, watchedMs: row.watched_ms }));
  }

  /** Every account, admins first, then by name. */
  public static accounts(): AccountRow[] {
    return this.db
      .query<AccountRow, []>("SELECT id, name, email, role FROM user ORDER BY (role = 'admin') DESC, name COLLATE NOCASE")
      .all();
  }
}
