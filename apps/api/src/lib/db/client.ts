/**
 * SQLite database client. Owns the single `bun:sqlite` connection the rest of
 * the application queries through, and applies the schema on startup.
 *
 * The database file location comes from the `DATABASE_PATH` environment
 * variable, falling back to `findr.db` at the repository root. Passing
 * `:memory:` yields an ephemeral database, which is useful in tests.
 */

import { Database } from "bun:sqlite";
import { existsSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { jobsSchema } from "./schema/jobs";
import { indexesSchema } from "./schema/indexes";

/**
 * Every table and index the application owns, in dependency order. Each
 * statement is idempotent (`IF NOT EXISTS`), so applying the list to an
 * already-populated database is a no-op.
 *
 * BetterAuth's tables are deliberately absent: it derives its own schema from
 * its options and creates them through `migrateAuth`. The foreign keys onto
 * `user` still resolve, because SQLite checks them when a row is written
 * rather than when the table is declared.
 */
const schema = [...jobsSchema, ...indexesSchema];

/**
 * Owns the SQLite connection and keeps its schema up to date.
 *
 * SQLite ships with settings tuned for embedded, single-process use, so the
 * constructor applies the pragmas a concurrent server needs. Most importantly
 * `foreign_keys` is off by default in SQLite — without enabling it the
 * `REFERENCES` and `ON DELETE CASCADE` clauses in the schema are silently
 * ignored at runtime.
 */
export class DatabaseClient {
  /** The underlying `bun:sqlite` connection. */
  public readonly connection: Database;

  /**
   * Whether this database lives only in memory. Bun treats `:memory:`, the
   * empty string and no argument at all as in-memory, so this is decided from
   * the requested path rather than read back off the connection.
   */
  private readonly ephemeral: boolean;

  /**
   * Opens (creating it if needed) the database file and prepares it for use.
   * The path defaults to `DATABASE_PATH`, then to `findr.db`. Relative paths
   * and the default both resolve against the repository root rather than the
   * working directory, so the same file is used whether the API is started
   * from the repo root, from `apps/api`, or from the production bundle.
   */
  constructor(path: string = process.env.DATABASE_PATH ?? "findr.db") {
    this.ephemeral = path === ":memory:" || path === "";

    // Anchor relative paths to the repo root; leave in-memory names alone
    const location =
      this.ephemeral || isAbsolute(path)
        ? path
        : join(DatabaseClient.repositoryRoot(), path);

    // Open the database file, creating it on first run. `strict` lets queries
    // bind named parameters as `{ id }` rather than `{ $id }`, and raises on a
    // missing one instead of silently binding null.
    this.connection = new Database(location, { create: true, strict: true });

    // Prepare the connection, then bring the schema up to date
    this.applyPragmas();
    this.applySchema();
  }

  /**
   * Walks up from this module's location to find the repository root, marked
   * by `bun.lock`. Works both in development (`apps/api/src/lib/db`) and from
   * the production bundle (`dist/index.js`). Falls back to the working
   * directory when no marker is found, as in a standalone deployment of
   * `dist/` — set `DATABASE_PATH` explicitly in that case.
   */
  private static repositoryRoot(): string {
    // Climb until the root marker turns up or the filesystem root is reached
    let directory = import.meta.dir;
    while (true) {
      if (existsSync(join(directory, "bun.lock"))) return directory;

      const parent = dirname(directory);
      if (parent === directory) return resolve(process.cwd());
      directory = parent;
    }
  }

  /**
   * Configures the connection for concurrent server use. Skipped for
   * in-memory databases, where journalling and synchronous writes are moot.
   */
  private applyPragmas(): void {
    // Enforce the foreign keys declared in the schema
    this.connection.run("PRAGMA foreign_keys = ON");

    // Bail out early for ephemeral databases — WAL has no meaning there
    if (this.ephemeral) return;

    // Allow readers and a writer to work concurrently
    this.connection.run("PRAGMA journal_mode = WAL");

    // Trade a fsync per transaction for durability at checkpoint boundaries
    this.connection.run("PRAGMA synchronous = NORMAL");

    // Wait rather than immediately erroring when another writer holds the lock
    this.connection.run("PRAGMA busy_timeout = 5000");
  }

  /**
   * Creates any missing tables and indexes. This is create-only: it brings a
   * fresh database up to the current schema but does not alter existing
   * tables, so a change to a column that is already deployed needs a migration
   * statement rather than an edit to the `CREATE TABLE` it came from.
   */
  private applySchema(): void {
    // Apply the whole schema as one unit so a failure leaves nothing behind
    this.connection.transaction(() => {
      for (const statement of schema) this.connection.run(statement);
    })();
  }

  /**
   * Releases the connection once every outstanding statement has been
   * finalised, via `sqlite3_close_v2`.
   *
   * Deliberately not `close(true)`, which finalises immediately and throws on
   * error: BetterAuth is handed this same connection and keeps its own
   * prepared statements on it, so forcing the issue raises "database is
   * locked" on any process that has served an auth request.
   */
  public close(): void {
    this.connection.close();
  }
}

/** Process-wide client instance. */
export const client = new DatabaseClient();

/** The shared connection. Models issue their queries against this. */
export const database = client.connection;
