/**
 * Every schema change the application has ever made, in order. A migration's
 * position in this list is its version: the database records the highest
 * version applied in `PRAGMA user_version`, and the migrator runs whatever
 * comes after it.
 *
 * Migrations are append-only. Once one has shipped, never edit it — add a new
 * one that alters what it created.
 *
 * Timestamps are INTEGER epoch milliseconds and JSON columns are TEXT, since
 * SQLite has neither type; converting them is the models' job. BetterAuth's
 * tables are not here — BetterAuth migrates its own schema at startup. The
 * foreign keys onto `user` still resolve, because SQLite checks them when a
 * row is written rather than when the table is created.
 */

/** One forward-only schema change. */
export interface Migration {
  /** Short description, logged when the migration runs. */
  name: string;
  /** Statements run in order inside a single transaction. */
  statements: string[];
}

export const migrations: Migration[] = [
  {
    name: "downloads pipeline schema",
    statements: [
      // The pre-release jobs/indexes/torrents tables were never populated
      "DROP TABLE IF EXISTS torrents",
      "DROP TABLE IF EXISTS indexes",
      "DROP TABLE IF EXISTS jobs",

      // A movie or show someone has asked for, keyed by TMDB identity
      `CREATE TABLE titles (
        id         TEXT PRIMARY KEY NOT NULL,
        tmdb_id    INTEGER NOT NULL,
        media_type TEXT NOT NULL CHECK (media_type IN ('movie', 'tv')),
        created_at INTEGER NOT NULL,
        UNIQUE (tmdb_id, media_type)
      )`,

      // One request to acquire a movie or a single season
      `CREATE TABLE downloads (
        id             TEXT PRIMARY KEY NOT NULL,
        title_id       TEXT NOT NULL REFERENCES titles(id) ON DELETE CASCADE,
        season         INTEGER,
        status         TEXT NOT NULL,
        status_message TEXT,
        result         TEXT,
        run            INTEGER NOT NULL DEFAULT 1,
        requested_by   TEXT REFERENCES user(id) ON DELETE SET NULL,
        created_at     INTEGER NOT NULL,
        updated_at     INTEGER NOT NULL
      )`,
      "CREATE INDEX downloads_title_idx ON downloads (title_id, season)",
      "CREATE INDEX downloads_status_idx ON downloads (status, updated_at)",

      // Per-episode progress for season downloads
      `CREATE TABLE episodes (
        id             TEXT PRIMARY KEY NOT NULL,
        download_id    TEXT NOT NULL REFERENCES downloads(id) ON DELETE CASCADE,
        episode_number INTEGER NOT NULL,
        status         TEXT NOT NULL,
        status_message TEXT,
        updated_at     INTEGER NOT NULL,
        UNIQUE (download_id, episode_number)
      )`,

      // Every release considered, including those rejected before scoring
      `CREATE TABLE candidates (
        id               TEXT PRIMARY KEY NOT NULL,
        download_id      TEXT NOT NULL REFERENCES downloads(id) ON DELETE CASCADE,
        episode_id       TEXT REFERENCES episodes(id) ON DELETE CASCADE,
        title            TEXT NOT NULL,
        indexer          TEXT NOT NULL,
        info_hash        TEXT,
        magnet_uri       TEXT,
        download_url     TEXT,
        size_mb          INTEGER NOT NULL,
        seeders          INTEGER NOT NULL,
        leechers         INTEGER NOT NULL,
        published_at     INTEGER,
        parsed           TEXT NOT NULL,
        score            REAL,
        status           TEXT NOT NULL,
        rejection_reason TEXT,
        pinned           INTEGER NOT NULL DEFAULT 0,
        created_at       INTEGER NOT NULL
      )`,
      "CREATE INDEX candidates_lookup_idx ON candidates (download_id, episode_id, status)",

      // One try of one candidate, kept as history across retries
      `CREATE TABLE attempts (
        id           TEXT PRIMARY KEY NOT NULL,
        download_id  TEXT NOT NULL REFERENCES downloads(id) ON DELETE CASCADE,
        candidate_id TEXT NOT NULL REFERENCES candidates(id) ON DELETE CASCADE,
        episode_id   TEXT REFERENCES episodes(id) ON DELETE CASCADE,
        run          INTEGER NOT NULL,
        phase        TEXT NOT NULL,
        progress     REAL NOT NULL DEFAULT 0,
        outcome      TEXT,
        reason       TEXT,
        started_at   INTEGER NOT NULL,
        finished_at  INTEGER
      )`,
      "CREATE INDEX attempts_download_idx ON attempts (download_id, run)",
      "CREATE INDEX attempts_open_idx ON attempts (outcome)",

      // User-tunable settings, one JSON document per section
      `CREATE TABLE settings (
        key        TEXT PRIMARY KEY NOT NULL,
        value      TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      )`,
    ],
  },
];
