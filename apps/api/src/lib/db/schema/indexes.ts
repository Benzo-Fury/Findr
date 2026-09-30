/**
 * The `indexes` and `torrents` tables: indexed content and the scored torrent
 * results behind it.
 *
 * The two tables reference each other — an index points at its chosen source
 * torrent, and every torrent belongs to an index. SQLite resolves foreign keys
 * at write time rather than at `CREATE TABLE` time, so the forward reference
 * from `indexes` to `torrents` is fine as long as both exist before any insert.
 *
 * Timestamps are INTEGER holding Unix epoch milliseconds; converting them to
 * `Date` is the model's job.
 */

/** An `indexes` row as stored, with `created_at` in epoch ms. */
export type IndexRow = {
  id: string;
  imdb_id: string;
  season: number | null;
  /** The chosen torrent, or null until the decide stage picks one. */
  source_id: string | null;
  user_id: string;
  created_at: number;
};

/** A `torrents` row as stored, with `created_at` in epoch ms. */
export type TorrentRow = {
  id: string;
  index_id: string;
  title: string;
  magnet_link: string;
  size_mb: number;
  seeders: number;
  leechers: number;
  resolution: string | null;
  video_codec: string | null;
  audio_codec: string | null;
  hdr_format: string | null;
  release_type: string | null;
  uploader_name: string | null;
  /** Computed ranking score, stored as REAL. */
  score: number;
  created_at: number;
};

/**
 * Statements that create both tables and their indexes.
 *
 * `indexes` is created first so that `torrents.index_id` resolves, and the
 * unique index on `(imdb_id, season)` keeps one index per movie or season.
 */
export const indexesSchema = [
  `CREATE TABLE IF NOT EXISTS indexes (
    id         TEXT PRIMARY KEY NOT NULL,
    imdb_id    TEXT NOT NULL,
    season     INTEGER,
    source_id  TEXT REFERENCES torrents(id),
    user_id    TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    FOREIGN KEY (user_id) REFERENCES user(id)
  )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS indexes_imdb_season_idx ON indexes (imdb_id, season)`,
  `CREATE INDEX IF NOT EXISTS indexes_user_id_idx ON indexes (user_id)`,
  `CREATE TABLE IF NOT EXISTS torrents (
    id            TEXT PRIMARY KEY NOT NULL,
    index_id      TEXT NOT NULL REFERENCES indexes(id) ON DELETE CASCADE,
    title         TEXT NOT NULL,
    magnet_link   TEXT NOT NULL,
    size_mb       INTEGER NOT NULL,
    seeders       INTEGER NOT NULL,
    leechers      INTEGER NOT NULL,
    resolution    TEXT,
    video_codec   TEXT,
    audio_codec   TEXT,
    hdr_format    TEXT,
    release_type  TEXT,
    uploader_name TEXT,
    score         REAL NOT NULL,
    created_at    INTEGER NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS torrents_index_id_idx ON torrents (index_id)`,
];
