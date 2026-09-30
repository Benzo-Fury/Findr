/**
 * One episode of a season download. Episodes exist so a season can fall back
 * to fetching episode by episode, with each one tracking its own status,
 * candidates and attempts.
 */

import type { EpisodeRecord, EpisodeStatus } from "@findr/types/downloads";
import { Model } from "./Model";

// ---------- Rows ---------- //

/** An `episodes` row as stored. */
interface EpisodeRow {
  id: string;
  download_id: string;
  episode_number: number;
  status: EpisodeStatus;
  status_message: string | null;
  updated_at: number;
}

// ---------- Model ---------- //

export class Episode extends Model {
  public readonly id: string;
  public readonly downloadId: string;
  public readonly episodeNumber: number;
  private statusValue: EpisodeStatus;
  private statusMessageValue: string | null;

  private constructor(row: EpisodeRow) {
    super();
    this.id = row.id;
    this.downloadId = row.download_id;
    this.episodeNumber = row.episode_number;
    this.statusValue = row.status;
    this.statusMessageValue = row.status_message;
  }

  public get status(): EpisodeStatus {
    return this.statusValue;
  }

  // ---------- Queries ---------- //

  /**
   * Records the episode list for a season. Existing rows are kept as they
   * are, so re-planning a resumed download never resets finished episodes.
   */
  public static ensure(downloadId: string, episodes: Array<{ number: number; status: EpisodeStatus }>): Episode[] {
    const insert = this.db.query(
      `INSERT INTO episodes (id, download_id, episode_number, status, updated_at)
       VALUES ($id, $downloadId, $number, $status, $now)
       ON CONFLICT (download_id, episode_number) DO NOTHING`,
    );

    // Insert the whole list atomically
    this.transaction(() => {
      for (const episode of episodes) {
        insert.run({ id: this.newId(), downloadId, number: episode.number, status: episode.status, now: Date.now() });
      }
    });

    return this.forDownload(downloadId);
  }

  /** Every episode of a download, in episode order. */
  public static forDownload(downloadId: string): Episode[] {
    return this.db
      .query<EpisodeRow, { downloadId: string }>(
        "SELECT * FROM episodes WHERE download_id = $downloadId ORDER BY episode_number",
      )
      .all({ downloadId })
      .map((row) => new Episode(row));
  }

  // ---------- Mutations ---------- //

  public setStatus(status: EpisodeStatus, message: string | null = null): void {
    Episode.db
      .query("UPDATE episodes SET status = $status, status_message = $message, updated_at = $now WHERE id = $id")
      .run({ id: this.id, status, message, now: Date.now() });
    this.statusValue = status;
    this.statusMessageValue = message;
  }

  // ---------- Serialisation ---------- //

  public toRecord(): EpisodeRecord {
    return {
      id: this.id,
      episodeNumber: this.episodeNumber,
      status: this.statusValue,
      statusMessage: this.statusMessageValue,
    };
  }
}
