/**
 * How far one user got through one movie or episode: the resume point,
 * whether it counts as played, and when it was last watched. Movies are
 * stored with season and episode -1 so the primary key stays unique, and read
 * back as null.
 */

import type { PlaybackItemKey } from "@findr/types/playback";
import { Model } from "./Model";

// ---------- Rows ---------- //

/** A `playback_progress` row as stored. */
interface ProgressRow {
  user_id: string;
  title_id: string;
  season: number;
  episode: number;
  position_ms: number;
  duration_ms: number;
  played: number;
  play_count: number;
  audio_language: string | null;
  last_played_at: number;
}

/** Stand-in for a missing season or episode in the key. */
const NONE = -1;

/** The key's columns, with null stored as the stand-in. */
function stored(key: PlaybackItemKey): { titleId: string; season: number; episode: number } {
  return { titleId: key.titleId, season: key.season ?? NONE, episode: key.episode ?? NONE };
}

// ---------- Model ---------- //

export class PlaybackProgress extends Model {
  public readonly userId: string;
  public readonly titleId: string;
  public readonly season: number | null;
  public readonly episode: number | null;
  public readonly positionMs: number;
  public readonly durationMs: number;
  public readonly played: boolean;
  public readonly playCount: number;
  public readonly audioLanguage: string | null;
  public readonly lastPlayedAt: number;

  private constructor(row: ProgressRow) {
    super();
    this.userId = row.user_id;
    this.titleId = row.title_id;
    this.season = row.season === NONE ? null : row.season;
    this.episode = row.episode === NONE ? null : row.episode;
    this.positionMs = row.position_ms;
    this.durationMs = row.duration_ms;
    this.played = row.played === 1;
    this.playCount = row.play_count;
    this.audioLanguage = row.audio_language;
    this.lastPlayedAt = row.last_played_at;
  }

  /** The key this progress belongs to. */
  public get key(): PlaybackItemKey {
    return { titleId: this.titleId, season: this.season, episode: this.episode };
  }

  // ---------- Queries ---------- //

  public static find(userId: string, key: PlaybackItemKey): PlaybackProgress | null {
    const row = this.db
      .query<ProgressRow, { userId: string; titleId: string; season: number; episode: number }>(
        `SELECT * FROM playback_progress
         WHERE user_id = $userId AND title_id = $titleId AND season = $season AND episode = $episode`,
      )
      .get({ userId, ...stored(key) });
    return row ? new PlaybackProgress(row) : null;
  }

  /** Everything a user has watched or started, most recent first. */
  public static forUser(userId: string): PlaybackProgress[] {
    return this.db
      .query<ProgressRow, { userId: string }>("SELECT * FROM playback_progress WHERE user_id = $userId ORDER BY last_played_at DESC")
      .all({ userId })
      .map((row) => new PlaybackProgress(row));
  }

  /** The audio language a user last chose anywhere in a title, to keep it across episodes. */
  public static lastAudioLanguage(userId: string, titleId: string): string | null {
    const row = this.db
      .query<{ audio_language: string | null }, { userId: string; titleId: string }>(
        `SELECT audio_language FROM playback_progress
         WHERE user_id = $userId AND title_id = $titleId AND audio_language IS NOT NULL
         ORDER BY last_played_at DESC LIMIT 1`,
      )
      .get({ userId, titleId });
    return row?.audio_language ?? null;
  }

  // ---------- Mutations ---------- //

  /**
   * Records a position. `finished` marks the item played and clears its
   * resume point, counting one more play the first time it happens in a
   * viewing.
   */
  public static record(
    userId: string,
    key: PlaybackItemKey,
    state: { positionMs: number; durationMs: number; finished: boolean; audioLanguage?: string | null },
  ): void {
    const previous = this.find(userId, key);
    const newlyFinished = state.finished && !(previous?.played && previous.positionMs === 0);

    this.db
      .query(
        `INSERT INTO playback_progress
           (user_id, title_id, season, episode, position_ms, duration_ms, played, play_count, audio_language, last_played_at)
         VALUES ($userId, $titleId, $season, $episode, $position, $duration, $played, $plays, $audio, $now)
         ON CONFLICT (user_id, title_id, season, episode) DO UPDATE SET
           position_ms = excluded.position_ms, duration_ms = excluded.duration_ms,
           played = MAX(playback_progress.played, excluded.played),
           play_count = playback_progress.play_count + $added,
           audio_language = COALESCE(excluded.audio_language, playback_progress.audio_language),
           last_played_at = excluded.last_played_at`,
      )
      .run({
        userId,
        ...stored(key),
        position: state.finished ? 0 : state.positionMs,
        duration: state.durationMs,
        played: state.finished ? 1 : 0,
        plays: newlyFinished ? 1 : 0,
        added: newlyFinished ? 1 : 0,
        audio: state.audioLanguage ?? null,
        now: Date.now(),
      });
  }

  /** Marks an item played or unplayed by hand, clearing its resume point either way. */
  public static setPlayed(userId: string, key: PlaybackItemKey, played: boolean): void {
    this.db
      .query(
        `INSERT INTO playback_progress (user_id, title_id, season, episode, position_ms, played, play_count, last_played_at)
         VALUES ($userId, $titleId, $season, $episode, 0, $played, $played, $now)
         ON CONFLICT (user_id, title_id, season, episode) DO UPDATE SET
           position_ms = 0, played = excluded.played,
           play_count = CASE WHEN excluded.played = 1 AND playback_progress.played = 0
                             THEN playback_progress.play_count + 1 ELSE playback_progress.play_count END,
           last_played_at = excluded.last_played_at`,
      )
      .run({ userId, ...stored(key), played: played ? 1 : 0, now: Date.now() });
  }
}
