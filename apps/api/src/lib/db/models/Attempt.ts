/**
 * One try of one candidate: download, inspect, sterilize, save. Attempts are
 * never deleted by retries, so a download's detail view shows the full history
 * across runs, including why each try failed.
 */

import type { AttemptOutcome, AttemptPhase, AttemptRecord } from "@findr/types/downloads";
import { Model } from "./Model";

// ---------- Rows ---------- //

/** An `attempts` row as stored. */
interface AttemptRow {
  id: string;
  download_id: string;
  candidate_id: string;
  episode_id: string | null;
  run: number;
  phase: AttemptPhase;
  progress: number;
  outcome: AttemptOutcome | null;
  reason: string | null;
  started_at: number;
  finished_at: number | null;
}

/** Identifies what an attempt is trying and on whose behalf. */
export interface NewAttempt {
  downloadId: string;
  candidateId: string;
  episodeId: string | null;
  run: number;
}

// ---------- Model ---------- //

export class Attempt extends Model {
  public readonly id: string;
  public readonly downloadId: string;
  public readonly candidateId: string;
  public readonly episodeId: string | null;
  public readonly run: number;
  public readonly startedAt: number;
  private phaseValue: AttemptPhase;
  private progressValue: number;
  private outcomeValue: AttemptOutcome | null;
  private reasonValue: string | null;
  private finishedAtValue: number | null;

  private constructor(row: AttemptRow) {
    super();
    this.id = row.id;
    this.downloadId = row.download_id;
    this.candidateId = row.candidate_id;
    this.episodeId = row.episode_id;
    this.run = row.run;
    this.startedAt = row.started_at;
    this.phaseValue = row.phase;
    this.progressValue = row.progress;
    this.outcomeValue = row.outcome;
    this.reasonValue = row.reason;
    this.finishedAtValue = row.finished_at;
  }

  public get phase(): AttemptPhase {
    return this.phaseValue;
  }

  public get progress(): number {
    return this.progressValue;
  }

  // ---------- Queries ---------- //

  /** Opens a new attempt in the metadata phase. */
  public static start(attempt: NewAttempt): Attempt {
    const row: AttemptRow = {
      id: this.newId(),
      download_id: attempt.downloadId,
      candidate_id: attempt.candidateId,
      episode_id: attempt.episodeId,
      run: attempt.run,
      phase: "metadata",
      progress: 0,
      outcome: null,
      reason: null,
      started_at: Date.now(),
      finished_at: null,
    };

    this.db
      .query(
        `INSERT INTO attempts (id, download_id, candidate_id, episode_id, run, phase, progress, started_at)
         VALUES ($id, $downloadId, $candidateId, $episodeId, $run, $phase, 0, $startedAt)`,
      )
      .run({
        id: row.id,
        downloadId: row.download_id,
        candidateId: row.candidate_id,
        episodeId: row.episode_id,
        run: row.run,
        phase: row.phase,
        startedAt: row.started_at,
      });

    return new Attempt(row);
  }

  /** Every attempt of a download, newest first. */
  public static forDownload(downloadId: string): Attempt[] {
    return this.db
      .query<AttemptRow, { downloadId: string }>(
        "SELECT * FROM attempts WHERE download_id = $downloadId ORDER BY started_at DESC, rowid DESC",
      )
      .all({ downloadId })
      .map((row) => new Attempt(row));
  }

  /** The attempt currently running for a download, if any. */
  public static activeFor(downloadId: string): Attempt | null {
    const row = this.db
      .query<AttemptRow, { downloadId: string }>(
        "SELECT * FROM attempts WHERE download_id = $downloadId AND outcome IS NULL ORDER BY started_at DESC, rowid DESC LIMIT 1",
      )
      .get({ downloadId });
    return row ? new Attempt(row) : null;
  }

  /** Attempts that never recorded an outcome — left open by a crash or restart. */
  public static unfinished(): Attempt[] {
    return this.db
      .query<AttemptRow, []>("SELECT * FROM attempts WHERE outcome IS NULL")
      .all()
      .map((row) => new Attempt(row));
  }

  /**
   * How many attempts of one unit have failed in the given run — the count
   * the attempt limit applies to. Interrupted attempts (a restart, or the
   * environment breaking mid-attempt) are not the release's fault and do not
   * count.
   */
  public static failuresFor(downloadId: string, episodeId: string | null, run: number): number {
    const row = this.db
      .query<{ total: number }, { downloadId: string; episodeId: string | null; run: number }>(
        `SELECT COUNT(*) AS total FROM attempts
         WHERE download_id = $downloadId AND episode_id IS $episodeId AND run = $run
           AND outcome = 'failed'`,
      )
      .get({ downloadId, episodeId, run });
    return row?.total ?? 0;
  }

  // ---------- Mutations ---------- //

  /** Moves the attempt to a new phase, resetting progress unless given. */
  public setPhase(phase: AttemptPhase, progress = 0): void {
    Attempt.db
      .query("UPDATE attempts SET phase = $phase, progress = $progress WHERE id = $id")
      .run({ id: this.id, phase, progress });
    this.phaseValue = phase;
    this.progressValue = progress;
  }

  /** Records progress within the current phase, clamped to 0–1. */
  public setProgress(progress: number): void {
    const clamped = Math.min(Math.max(progress, 0), 1);
    Attempt.db.query("UPDATE attempts SET progress = $progress WHERE id = $id").run({ id: this.id, progress: clamped });
    this.progressValue = clamped;
  }

  /** Closes the attempt with its outcome and, for anything but success, why. */
  public finish(outcome: AttemptOutcome, reason: string | null = null): void {
    const finishedAt = Date.now();
    const phase: AttemptPhase = outcome === "succeeded" ? "done" : this.phaseValue;

    Attempt.db
      .query("UPDATE attempts SET outcome = $outcome, reason = $reason, phase = $phase, finished_at = $finishedAt WHERE id = $id")
      .run({ id: this.id, outcome, reason, phase, finishedAt });

    this.outcomeValue = outcome;
    this.reasonValue = reason;
    this.phaseValue = phase;
    this.finishedAtValue = finishedAt;
  }

  // ---------- Serialisation ---------- //

  public toRecord(): AttemptRecord {
    return {
      id: this.id,
      candidateId: this.candidateId,
      episodeId: this.episodeId,
      run: this.run,
      phase: this.phaseValue,
      progress: this.progressValue,
      outcome: this.outcomeValue,
      reason: this.reasonValue,
      startedAt: this.startedAt,
      finishedAt: this.finishedAtValue,
    };
  }
}
