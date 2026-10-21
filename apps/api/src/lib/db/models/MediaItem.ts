/**
 * A library file that can be played: one movie, or one episode of a season.
 * The playback indexer writes a row after probing each file the pipeline
 * saves, so a session never has to inspect the file itself before starting.
 * Rows go with their title, and are dropped when the file disappears.
 */

import type { MediaType } from "@findr/types/media";
import type { PlaybackItemKey } from "@findr/types/playback";
import type { ProbeInfo } from "../../playback/MediaProbe";
import { Model } from "./Model";

// ---------- Rows ---------- //

/** A `media_items` row as stored. */
interface MediaItemRow {
  id: string;
  title_id: string;
  download_id: string | null;
  season: number | null;
  episode: number | null;
  path: string;
  size: number;
  mtime: number;
  duration_ms: number;
  probe: string;
  keyframes: Uint8Array;
  indexed_at: number;
}

/** What the indexer records about a file. */
export interface MediaItemInput {
  titleId: string;
  downloadId: string | null;
  season: number | null;
  episode: number | null;
  path: string;
  size: number;
  mtime: number;
  probe: ProbeInfo;
  /** Video keyframe times in seconds from the start of the file. */
  keyframes: Float64Array;
}

/** A media item together with its title's TMDB identity. */
export interface MediaItemWithTitle {
  item: MediaItem;
  tmdbId: number;
  mediaType: MediaType;
}

// ---------- Model ---------- //

export class MediaItem extends Model {
  public readonly id: string;
  public readonly titleId: string;
  public readonly downloadId: string | null;
  public readonly season: number | null;
  public readonly episode: number | null;
  public readonly path: string;
  public readonly size: number;
  public readonly mtime: number;
  public readonly durationMs: number;
  public readonly probe: ProbeInfo;
  public readonly keyframes: Float64Array;
  public readonly indexedAt: number;

  private constructor(row: MediaItemRow) {
    super();
    this.id = row.id;
    this.titleId = row.title_id;
    this.downloadId = row.download_id;
    this.season = row.season;
    this.episode = row.episode;
    this.path = row.path;
    this.size = row.size;
    this.mtime = row.mtime;
    this.durationMs = row.duration_ms;
    this.probe = JSON.parse(row.probe) as ProbeInfo;

    // Copy out of the blob so the array is aligned for Float64 reads
    const bytes = new Uint8Array(row.keyframes);
    this.keyframes = new Float64Array(bytes.buffer, bytes.byteOffset, bytes.byteLength / Float64Array.BYTES_PER_ELEMENT);
    this.indexedAt = row.indexed_at;
  }

  // ---------- Queries ---------- //

  public static find(id: string): MediaItem | null {
    const row = this.db.query<MediaItemRow, { id: string }>("SELECT * FROM media_items WHERE id = $id").get({ id });
    return row ? new MediaItem(row) : null;
  }

  public static findByPath(path: string): MediaItem | null {
    const row = this.db.query<MediaItemRow, { path: string }>("SELECT * FROM media_items WHERE path = $path").get({ path });
    return row ? new MediaItem(row) : null;
  }

  /** The newest file for a movie or episode, when there is one. */
  public static findForKey(key: PlaybackItemKey): MediaItem | null {
    const row = this.db
      .query<MediaItemRow, { titleId: string; season: number | null; episode: number | null }>(
        `SELECT * FROM media_items
         WHERE title_id = $titleId AND season IS $season AND episode IS $episode
         ORDER BY indexed_at DESC LIMIT 1`,
      )
      .get({ titleId: key.titleId, season: key.season, episode: key.episode });
    return row ? new MediaItem(row) : null;
  }

  /** Every item with its title's TMDB identity, in title, season and episode order. */
  public static allWithTitles(): MediaItemWithTitle[] {
    const rows = this.db
      .query<MediaItemRow & { tmdb_id: number; media_type: MediaType }, []>(
        `SELECT m.*, t.tmdb_id, t.media_type FROM media_items m
         JOIN titles t ON t.id = m.title_id
         ORDER BY m.title_id, m.season, m.episode, m.indexed_at DESC`,
      )
      .all();
    return rows.map((row) => ({ item: new MediaItem(row), tmdbId: row.tmdb_id, mediaType: row.media_type }));
  }

  /** The path and stamp of every indexed file, for reconciling against the disk. */
  public static stamps(): Array<{ id: string; path: string; size: number; mtime: number }> {
    return this.db.query<{ id: string; path: string; size: number; mtime: number }, []>("SELECT id, path, size, mtime FROM media_items").all();
  }

  // ---------- Mutations ---------- //

  /** Records a probed file, replacing what was known about the same path. */
  public static upsert(input: MediaItemInput): MediaItem {
    const keyframes = new Uint8Array(input.keyframes.buffer, input.keyframes.byteOffset, input.keyframes.byteLength);
    this.db
      .query(
        `INSERT INTO media_items (id, title_id, download_id, season, episode, path, size, mtime, duration_ms, probe, keyframes, indexed_at)
         VALUES ($id, $titleId, $downloadId, $season, $episode, $path, $size, $mtime, $durationMs, $probe, $keyframes, $now)
         ON CONFLICT (path) DO UPDATE SET
           title_id = excluded.title_id, download_id = excluded.download_id, season = excluded.season,
           episode = excluded.episode, size = excluded.size, mtime = excluded.mtime,
           duration_ms = excluded.duration_ms, probe = excluded.probe, keyframes = excluded.keyframes,
           indexed_at = excluded.indexed_at`,
      )
      .run({
        id: this.newId(),
        titleId: input.titleId,
        downloadId: input.downloadId,
        season: input.season,
        episode: input.episode,
        path: input.path,
        size: input.size,
        mtime: input.mtime,
        durationMs: input.probe.durationMs,
        probe: JSON.stringify(input.probe),
        keyframes,
        now: Date.now(),
      });

    const item = this.findByPath(input.path);
    if (!item) throw new Error(`Media item ${input.path} vanished after insert`);
    return item;
  }

  /** Forgets a file, such as one that is no longer on disk. */
  public static remove(id: string): void {
    this.db.query("DELETE FROM media_items WHERE id = $id").run({ id });
  }
}
