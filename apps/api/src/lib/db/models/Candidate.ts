/**
 * A release considered for a download — the ranked list the attempt loop
 * walks. Candidates are persisted once per search, so retries walk the stored
 * list instead of querying indexers again.
 *
 * Download links are stored but never serialised: `toRecord()` omits them and
 * only `source()` exposes them, for the downloader. Links carry no secrets —
 * Prowlarr's API key is stripped before a candidate is created.
 */

import type { CandidateRecord, CandidateStatus } from "@findr/types/downloads";
import { ParsedReleaseSchema, type ParsedRelease } from "@findr/types/release";
import { Model } from "./Model";

// ---------- Rows ---------- //

/** A `candidates` row as stored. `parsed` is JSON; `pinned` is 0 or 1. */
interface CandidateRow {
  id: string;
  download_id: string;
  episode_id: string | null;
  title: string;
  indexer: string;
  info_hash: string | null;
  magnet_uri: string | null;
  download_url: string | null;
  size_mb: number;
  seeders: number;
  leechers: number;
  published_at: number | null;
  parsed: string;
  score: number | null;
  status: CandidateStatus;
  rejection_reason: string | null;
  pinned: number;
  created_at: number;
}

/** Everything needed to record a newly found release. */
export interface NewCandidate {
  downloadId: string;
  episodeId: string | null;
  title: string;
  indexer: string;
  infoHash: string | null;
  magnetUri: string | null;
  /** Must already have any API key removed. */
  downloadUrl: string | null;
  sizeMB: number;
  seeders: number;
  leechers: number;
  publishedAt: number | null;
  parsed: ParsedRelease;
  score: number | null;
  status: "pending" | "rejected";
  rejectionReason: string | null;
}

/** Where the downloader fetches a candidate from. */
export interface CandidateSource {
  infoHash: string | null;
  magnetUri: string | null;
  downloadUrl: string | null;
}

// ---------- Model ---------- //

export class Candidate extends Model {
  public readonly id: string;
  public readonly downloadId: string;
  public readonly episodeId: string | null;
  public readonly title: string;
  public readonly indexer: string;
  public readonly sizeMB: number;
  public readonly seeders: number;
  public readonly leechers: number;
  public readonly publishedAt: number | null;
  public readonly parsed: ParsedRelease;
  public readonly score: number | null;
  private readonly links: CandidateSource;
  private statusValue: CandidateStatus;
  private rejectionReasonValue: string | null;
  private pinnedValue: boolean;

  private constructor(row: CandidateRow) {
    super();
    this.id = row.id;
    this.downloadId = row.download_id;
    this.episodeId = row.episode_id;
    this.title = row.title;
    this.indexer = row.indexer;
    this.sizeMB = row.size_mb;
    this.seeders = row.seeders;
    this.leechers = row.leechers;
    this.publishedAt = row.published_at;
    this.parsed = ParsedReleaseSchema.parse(JSON.parse(row.parsed));
    this.score = row.score;
    this.links = { infoHash: row.info_hash, magnetUri: row.magnet_uri, downloadUrl: row.download_url };
    this.statusValue = row.status;
    this.rejectionReasonValue = row.rejection_reason;
    this.pinnedValue = row.pinned === 1;
  }

  public get status(): CandidateStatus {
    return this.statusValue;
  }

  // ---------- Queries ---------- //

  /** Records a batch of search results for one download (or one episode of it). */
  public static insertMany(candidates: NewCandidate[]): void {
    const insert = this.db.query(
      `INSERT INTO candidates (
         id, download_id, episode_id, title, indexer, info_hash, magnet_uri, download_url,
         size_mb, seeders, leechers, published_at, parsed, score, status, rejection_reason, created_at
       ) VALUES (
         $id, $downloadId, $episodeId, $title, $indexer, $infoHash, $magnetUri, $downloadUrl,
         $sizeMB, $seeders, $leechers, $publishedAt, $parsed, $score, $status, $rejectionReason, $now
       )`,
    );

    // Store the whole batch or none of it
    this.transaction(() => {
      for (const candidate of candidates) {
        insert.run({
          id: this.newId(),
          downloadId: candidate.downloadId,
          episodeId: candidate.episodeId,
          title: candidate.title,
          indexer: candidate.indexer,
          infoHash: candidate.infoHash,
          magnetUri: candidate.magnetUri,
          downloadUrl: candidate.downloadUrl,
          sizeMB: candidate.sizeMB,
          seeders: candidate.seeders,
          leechers: candidate.leechers,
          publishedAt: candidate.publishedAt,
          parsed: JSON.stringify(candidate.parsed),
          score: candidate.score,
          status: candidate.status,
          rejectionReason: candidate.rejectionReason,
          now: Date.now(),
        });
      }
    });
  }

  public static find(id: string): Candidate | null {
    const row = this.db.query<CandidateRow, { id: string }>("SELECT * FROM candidates WHERE id = $id").get({ id });
    return row ? new Candidate(row) : null;
  }

  /** Every candidate of a download, best first within each unit. */
  public static forDownload(downloadId: string): Candidate[] {
    return this.db
      .query<CandidateRow, { downloadId: string }>(
        `SELECT * FROM candidates WHERE download_id = $downloadId
         ORDER BY episode_id, pinned DESC, score IS NULL, score DESC`,
      )
      .all({ downloadId })
      .map((row) => new Candidate(row));
  }

  /**
   * The pending candidates for one unit of work — the movie or season pack
   * when `episodeId` is null, otherwise that episode — ranked best first.
   * Manually pinned candidates always come first.
   */
  public static pendingFor(downloadId: string, episodeId: string | null): Candidate[] {
    return this.db
      .query<CandidateRow, { downloadId: string; episodeId: string | null }>(
        `SELECT * FROM candidates
         WHERE download_id = $downloadId AND episode_id IS $episodeId AND status = 'pending'
         ORDER BY pinned DESC, score DESC`,
      )
      .all({ downloadId, episodeId })
      .map((row) => new Candidate(row));
  }

  /** Whether a unit has been searched at all, whatever the outcome. */
  public static existsFor(downloadId: string, episodeId: string | null): boolean {
    const row = this.db
      .query<{ found: number }, { downloadId: string; episodeId: string | null }>(
        "SELECT EXISTS (SELECT 1 FROM candidates WHERE download_id = $downloadId AND episode_id IS $episodeId) AS found",
      )
      .get({ downloadId, episodeId });
    return row?.found === 1;
  }

  /** Candidates left mid-attempt by a crash or restart. */
  public static stranded(): Candidate[] {
    return this.db
      .query<CandidateRow, []>("SELECT * FROM candidates WHERE status = 'attempting'")
      .all()
      .map((row) => new Candidate(row));
  }

  // ---------- Mutations ---------- //

  public markAttempting(): void {
    this.setStatus("attempting", null);
  }

  public markSucceeded(): void {
    this.setStatus("succeeded", null);
  }

  public reject(reason: string): void {
    this.setStatus("rejected", reason);
  }

  /**
   * Makes a previously tried candidate eligible again and, when pinned, puts
   * it ahead of every other candidate. Used when a user retries with a
   * specific release.
   */
  public requeue(pinned: boolean): void {
    Candidate.db
      .query("UPDATE candidates SET status = 'pending', rejection_reason = NULL, pinned = $pinned WHERE id = $id")
      .run({ id: this.id, pinned: pinned ? 1 : 0 });
    this.statusValue = "pending";
    this.rejectionReasonValue = null;
    this.pinnedValue = pinned;
  }

  /** Writes a status change and mirrors it on the instance. */
  private setStatus(status: CandidateStatus, reason: string | null): void {
    Candidate.db
      .query("UPDATE candidates SET status = $status, rejection_reason = $reason WHERE id = $id")
      .run({ id: this.id, status, reason });
    this.statusValue = status;
    this.rejectionReasonValue = reason;
  }

  // ---------- Serialisation ---------- //

  /** The links the downloader needs. Server-side only — never send this to a client. */
  public source(): CandidateSource {
    return { ...this.links };
  }

  /** The client-safe view, with every download link left out. */
  public toRecord(): CandidateRecord {
    return {
      id: this.id,
      episodeId: this.episodeId,
      title: this.title,
      indexer: this.indexer,
      sizeMB: this.sizeMB,
      seeders: this.seeders,
      leechers: this.leechers,
      publishedAt: this.publishedAt,
      parsed: this.parsed,
      score: this.score,
      status: this.statusValue,
      rejectionReason: this.rejectionReasonValue,
      pinned: this.pinnedValue,
    };
  }
}
