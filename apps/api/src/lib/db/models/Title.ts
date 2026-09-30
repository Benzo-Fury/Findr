/**
 * A movie or show someone has asked Findr to acquire. Titles hold only TMDB
 * identity — names, years and artwork are resolved from TMDB when needed, so
 * nothing here goes stale.
 */

import type { DownloadSummary, TitleSummary } from "@findr/types/downloads";
import type { MediaType } from "@findr/types/media";
import { Model } from "./Model";

// ---------- Rows ---------- //

/** A `titles` row as stored. */
interface TitleRow {
  id: string;
  tmdb_id: number;
  media_type: MediaType;
  created_at: number;
}

/** Filters accepted by `Title.list`. */
export interface TitleListOptions {
  page: number;
  pageSize: number;
  tmdbId?: number;
  mediaType?: MediaType;
}

// ---------- Model ---------- //

export class Title extends Model {
  public readonly id: string;
  public readonly tmdbId: number;
  public readonly mediaType: MediaType;
  public readonly createdAt: number;

  private constructor(row: TitleRow) {
    super();
    this.id = row.id;
    this.tmdbId = row.tmdb_id;
    this.mediaType = row.media_type;
    this.createdAt = row.created_at;
  }

  // ---------- Queries ---------- //

  /** Returns the title for a TMDB identity, creating it on first request. */
  public static findOrCreate(tmdbId: number, mediaType: MediaType): Title {
    // Insert if absent; the unique constraint makes concurrent requests safe
    this.db
      .query("INSERT INTO titles (id, tmdb_id, media_type, created_at) VALUES ($id, $tmdbId, $mediaType, $now) ON CONFLICT (tmdb_id, media_type) DO NOTHING")
      .run({ id: this.newId(), tmdbId, mediaType, now: Date.now() });

    const title = this.findByTmdb(tmdbId, mediaType);
    if (!title) throw new Error(`Title ${mediaType}/${tmdbId} vanished after insert`);
    return title;
  }

  public static find(id: string): Title | null {
    const row = this.db.query<TitleRow, { id: string }>("SELECT * FROM titles WHERE id = $id").get({ id });
    return row ? new Title(row) : null;
  }

  public static findByTmdb(tmdbId: number, mediaType: MediaType): Title | null {
    const row = this.db
      .query<TitleRow, { tmdbId: number; mediaType: MediaType }>(
        "SELECT * FROM titles WHERE tmdb_id = $tmdbId AND media_type = $mediaType",
      )
      .get({ tmdbId, mediaType });
    return row ? new Title(row) : null;
  }

  /**
   * A page of titles that have at least one download, most recently active
   * first, optionally narrowed to one TMDB identity.
   */
  public static list(options: TitleListOptions): { items: Title[]; total: number } {
    // Optional filters bind as null and match everything
    const filters = {
      tmdbId: options.tmdbId ?? null,
      mediaType: options.mediaType ?? null,
    };
    const where = `
      WHERE EXISTS (SELECT 1 FROM downloads d WHERE d.title_id = t.id)
        AND ($tmdbId IS NULL OR t.tmdb_id = $tmdbId)
        AND ($mediaType IS NULL OR t.media_type = $mediaType)`;

    const rows = this.db
      .query<TitleRow, typeof filters & { limit: number; offset: number }>(
        `SELECT t.* FROM titles t ${where}
         ORDER BY (SELECT MAX(d.updated_at) FROM downloads d WHERE d.title_id = t.id) DESC
         LIMIT $limit OFFSET $offset`,
      )
      .all({ ...filters, limit: options.pageSize, offset: this.offset(options.page, options.pageSize) });

    const counted = this.db
      .query<{ total: number }, typeof filters>(`SELECT COUNT(*) AS total FROM titles t ${where}`)
      .get(filters);

    return { items: rows.map((row) => new Title(row)), total: counted?.total ?? 0 };
  }

  // ---------- Mutations ---------- //

  /** Removes the title and, by cascade, every download, candidate and attempt beneath it. */
  public delete(): void {
    Title.db.query("DELETE FROM titles WHERE id = $id").run({ id: this.id });
  }

  // ---------- Serialisation ---------- //

  public toSummary(downloads: DownloadSummary[]): TitleSummary {
    return {
      id: this.id,
      tmdbId: this.tmdbId,
      mediaType: this.mediaType,
      createdAt: this.createdAt,
      downloads,
    };
  }
}
