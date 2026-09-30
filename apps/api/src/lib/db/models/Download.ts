/**
 * A request to acquire one movie or one season of a show. Stores only what
 * the client asked for — the title and season — plus lifecycle status and the
 * final result. Episodes, candidates and attempts hang off it and are removed
 * with it.
 */

import {
  TERMINAL_DOWNLOAD_STATUSES,
  type ActiveAttempt,
  type AttemptPhase,
  type DownloadDetail,
  type DownloadResult,
  type DownloadStatus,
  type DownloadSummary,
} from "@findr/types/downloads";
import type { MediaType } from "@findr/types/media";
import { Attempt } from "./Attempt";
import { Candidate } from "./Candidate";
import { Episode } from "./Episode";
import { Model } from "./Model";
import type { Title } from "./Title";

// ---------- Rows ---------- //

/** A `downloads` row joined with its title's TMDB identity. `result` is JSON. */
interface DownloadRow {
  id: string;
  title_id: string;
  tmdb_id: number;
  media_type: MediaType;
  season: number | null;
  status: DownloadStatus;
  status_message: string | null;
  result: string | null;
  run: number;
  requested_by: string | null;
  created_at: number;
  updated_at: number;
}

/** The live attempt's progress, joined with what it is downloading. */
interface ActiveAttemptRow {
  phase: AttemptPhase;
  progress: number;
  title: string;
  episode_number: number | null;
}

/** Filters accepted by `Download.list`. */
export interface DownloadListOptions {
  page: number;
  pageSize: number;
  status?: DownloadStatus;
  state?: "active" | "finished";
}

/** Every download with its title's identity, so instances never need a second lookup. */
const SELECT_DOWNLOAD = `
  SELECT d.*, t.tmdb_id, t.media_type
  FROM downloads d JOIN titles t ON t.id = d.title_id`;

/** Terminal statuses as a SQL list literal, for `IN (...)` filters. */
const TERMINAL_SQL = TERMINAL_DOWNLOAD_STATUSES.map((status) => `'${status}'`).join(", ");

// ---------- Model ---------- //

export class Download extends Model {
  public readonly id: string;
  public readonly titleId: string;
  public readonly tmdbId: number;
  public readonly mediaType: MediaType;
  public readonly season: number | null;
  public readonly requestedBy: string | null;
  public readonly createdAt: number;
  private statusValue: DownloadStatus;
  private statusMessageValue: string | null;
  private resultValue: DownloadResult | null;
  private runValue: number;
  private updatedAtValue: number;

  private constructor(row: DownloadRow) {
    super();
    this.id = row.id;
    this.titleId = row.title_id;
    this.tmdbId = row.tmdb_id;
    this.mediaType = row.media_type;
    this.season = row.season;
    this.requestedBy = row.requested_by;
    this.createdAt = row.created_at;
    this.statusValue = row.status;
    this.statusMessageValue = row.status_message;
    this.resultValue = row.result ? (JSON.parse(row.result) as DownloadResult) : null;
    this.runValue = row.run;
    this.updatedAtValue = row.updated_at;
  }

  public get status(): DownloadStatus {
    return this.statusValue;
  }

  public get run(): number {
    return this.runValue;
  }

  /** Whether the download has reached a status it never leaves on its own. */
  public get isFinished(): boolean {
    return TERMINAL_DOWNLOAD_STATUSES.includes(this.statusValue);
  }

  // ---------- Queries ---------- //

  /** Queues a new download for a title. */
  public static create(title: Title, season: number | null, requestedBy: string | null): Download {
    const id = this.newId();
    const now = Date.now();

    this.db
      .query(
        `INSERT INTO downloads (id, title_id, season, status, requested_by, created_at, updated_at)
         VALUES ($id, $titleId, $season, 'queued', $requestedBy, $now, $now)`,
      )
      .run({ id, titleId: title.id, season, requestedBy, now });

    const created = this.find(id);
    if (!created) throw new Error(`Download ${id} vanished after insert`);
    return created;
  }

  public static find(id: string): Download | null {
    const row = this.db.query<DownloadRow, { id: string }>(`${SELECT_DOWNLOAD} WHERE d.id = $id`).get({ id });
    return row ? new Download(row) : null;
  }

  /** The unfinished download for a title and season, if one is already underway. */
  public static findUnfinished(titleId: string, season: number | null): Download | null {
    const row = this.db
      .query<DownloadRow, { titleId: string; season: number | null }>(
        `${SELECT_DOWNLOAD}
         WHERE d.title_id = $titleId AND d.season IS $season AND d.status NOT IN (${TERMINAL_SQL})
         LIMIT 1`,
      )
      .get({ titleId, season });
    return row ? new Download(row) : null;
  }

  /** Every unfinished download, oldest first — the order the queue resumes them in. */
  public static unfinished(): Download[] {
    return this.db
      .query<DownloadRow, []>(`${SELECT_DOWNLOAD} WHERE d.status NOT IN (${TERMINAL_SQL}) ORDER BY d.created_at`)
      .all()
      .map((row) => new Download(row));
  }

  /** A page of downloads, most recently updated first. */
  public static list(options: DownloadListOptions): { items: Download[]; total: number } {
    // Optional filters bind as null and match everything
    const filters = { status: options.status ?? null, state: options.state ?? null };
    const where = `
      WHERE ($status IS NULL OR d.status = $status)
        AND ($state IS NULL
             OR ($state = 'active' AND d.status NOT IN (${TERMINAL_SQL}))
             OR ($state = 'finished' AND d.status IN (${TERMINAL_SQL})))`;

    const rows = this.db
      .query<DownloadRow, typeof filters & { limit: number; offset: number }>(
        `${SELECT_DOWNLOAD} ${where} ORDER BY d.updated_at DESC LIMIT $limit OFFSET $offset`,
      )
      .all({ ...filters, limit: options.pageSize, offset: this.offset(options.page, options.pageSize) });

    const counted = this.db
      .query<{ total: number }, typeof filters>(`SELECT COUNT(*) AS total FROM downloads d ${where}`)
      .get(filters);

    return { items: rows.map((row) => new Download(row)), total: counted?.total ?? 0 };
  }

  /** Every download of the given titles, newest first, grouped by title. */
  public static forTitles(titleIds: string[]): Map<string, Download[]> {
    const grouped = new Map<string, Download[]>(titleIds.map((id) => [id, []]));
    if (titleIds.length === 0) return grouped;

    // Bind each id positionally; the list is bounded by the titles page size
    const placeholders = titleIds.map(() => "?").join(", ");
    const rows = this.db
      .query<DownloadRow, string[]>(`${SELECT_DOWNLOAD} WHERE d.title_id IN (${placeholders}) ORDER BY d.created_at DESC`)
      .all(...titleIds);

    for (const row of rows) grouped.get(row.title_id)?.push(new Download(row));
    return grouped;
  }

  // ---------- Mutations ---------- //

  /** Moves the download to a new status with an optional human-readable note. */
  public setStatus(status: DownloadStatus, message: string | null = null): void {
    const now = Date.now();
    Download.db
      .query("UPDATE downloads SET status = $status, status_message = $message, updated_at = $now WHERE id = $id")
      .run({ id: this.id, status, message, now });
    this.statusValue = status;
    this.statusMessageValue = message;
    this.updatedAtValue = now;
  }

  /**
   * Adds library files to the result as each unit succeeds, so a restart
   * part-way through a season never loses track of what was saved.
   */
  public recordSavedFiles(files: string[]): void {
    const current = this.resultValue ?? { files: [] };
    this.writeResult({ ...current, files: [...new Set([...current.files, ...files])] });
  }

  /**
   * Ends the download with its final status and a summary line. Season
   * downloads also record which episodes ended which way; saved files are
   * already on the result.
   */
  public finish(
    status: "completed" | "partial" | "failed",
    message: string | null,
    episodes?: NonNullable<DownloadResult["episodes"]>,
  ): void {
    const current = this.resultValue ?? { files: [] };
    this.writeResult(episodes ? { ...current, episodes } : current);
    this.setStatus(status, message);
  }

  /** Persists the result document. */
  private writeResult(result: DownloadResult): void {
    Download.db
      .query("UPDATE downloads SET result = $result WHERE id = $id")
      .run({ id: this.id, result: JSON.stringify(result) });
    this.resultValue = result;
  }

  /**
   * Re-queues a finished download as a new run. Attempts from earlier runs are
   * kept as history but no longer count toward the attempt limit. Files saved
   * by earlier runs stay on the result — they are still in the library.
   */
  public startNewRun(): void {
    const now = Date.now();
    Download.db
      .query(
        "UPDATE downloads SET status = 'queued', status_message = NULL, run = run + 1, updated_at = $now WHERE id = $id",
      )
      .run({ id: this.id, now });
    this.statusValue = "queued";
    this.statusMessageValue = null;
    this.runValue += 1;
    this.updatedAtValue = now;
  }

  /** Removes the download and, by cascade, its episodes, candidates and attempts. */
  public delete(): void {
    Download.db.query("DELETE FROM downloads WHERE id = $id").run({ id: this.id });
  }

  // ---------- Serialisation ---------- //

  public toSummary(): DownloadSummary {
    return {
      id: this.id,
      titleId: this.titleId,
      tmdbId: this.tmdbId,
      mediaType: this.mediaType,
      season: this.season,
      status: this.statusValue,
      statusMessage: this.statusMessageValue,
      result: this.resultValue,
      run: this.runValue,
      requestedBy: this.requestedBy,
      createdAt: this.createdAt,
      updatedAt: this.updatedAtValue,
      activeAttempt: this.activeAttempt(),
    };
  }

  /** The summary plus every episode, candidate and attempt. */
  public toDetail(): DownloadDetail {
    return {
      ...this.toSummary(),
      episodes: Episode.forDownload(this.id).map((episode) => episode.toRecord()),
      candidates: Candidate.forDownload(this.id).map((candidate) => candidate.toRecord()),
      attempts: Attempt.forDownload(this.id).map((attempt) => attempt.toRecord()),
    };
  }

  /** Progress of the running attempt, if there is one. */
  private activeAttempt(): ActiveAttempt | null {
    const row = Download.db
      .query<ActiveAttemptRow, { id: string }>(
        `SELECT a.phase, a.progress, c.title, e.episode_number
         FROM attempts a
         JOIN candidates c ON c.id = a.candidate_id
         LEFT JOIN episodes e ON e.id = a.episode_id
         WHERE a.download_id = $id AND a.outcome IS NULL
         ORDER BY a.started_at DESC, a.rowid DESC LIMIT 1`,
      )
      .get({ id: this.id });

    if (!row) return null;
    return {
      phase: row.phase,
      progress: row.progress,
      candidateTitle: row.title,
      episodeNumber: row.episode_number,
    };
  }
}
