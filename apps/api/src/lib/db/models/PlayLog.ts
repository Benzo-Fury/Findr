/**
 * A record of every playback session once it ends: who watched what, on
 * which kind of device, how it was sent and where any conversion ran. Kept
 * for the Admin page's playback figures; nothing in playback reads it back.
 */

import type { PlaybackDevice, TranscodeRung } from "@findr/types/playback";
import { Model } from "./Model";

// ---------- Types ---------- //

/** How a session sent its file: as it was (`direct`), remuxed, with audio converted, or transcoded. */
export type PlayLogMode = "direct" | "remux" | "audio" | "transcode";

/** A `play_log` row as stored. */
interface PlayLogRow {
  user_id: string | null;
  title_id: string;
  season: number | null;
  episode: number | null;
  device: PlaybackDevice;
  mode: PlayLogMode;
  rung: TranscodeRung | null;
  started_at: number;
  ended_at: number;
}

/** One ended session, as recorded. */
export interface PlayLogEntry {
  userId: string | null;
  titleId: string;
  season: number | null;
  episode: number | null;
  device: PlaybackDevice;
  mode: PlayLogMode;
  rung: TranscodeRung | null;
  startedAt: number;
  endedAt: number;
}

// ---------- Model ---------- //

export class PlayLog extends Model {
  /** Records a session that has just ended. */
  public static record(entry: PlayLogEntry): void {
    this.db
      .query(
        `INSERT INTO play_log (id, user_id, title_id, season, episode, device, mode, rung, started_at, ended_at)
         VALUES ($id, $userId, $titleId, $season, $episode, $device, $mode, $rung, $startedAt, $endedAt)`,
      )
      .run({ id: this.newId(), ...entry });
  }

  /** Sessions that started at or after `since` and ran for at least `minMs`, oldest first. */
  public static since(since: number, minMs: number): PlayLogEntry[] {
    return this.db
      .query<PlayLogRow, { since: number; minMs: number }>(
        "SELECT * FROM play_log WHERE started_at >= $since AND ended_at - started_at >= $minMs ORDER BY started_at",
      )
      .all({ since, minMs })
      .map((row) => ({
        userId: row.user_id,
        titleId: row.title_id,
        season: row.season,
        episode: row.episode,
        device: row.device,
        mode: row.mode,
        rung: row.rung,
        startedAt: row.started_at,
        endedAt: row.ended_at,
      }));
  }
}
