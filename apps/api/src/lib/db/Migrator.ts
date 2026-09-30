/**
 * Brings a database up to the latest schema by applying every migration it
 * has not yet seen. The applied version is stored in SQLite's own
 * `PRAGMA user_version` header field, so no bookkeeping table is needed.
 */

import type { Database } from "bun:sqlite";
import type { Migration } from "./migrations";

export class Migrator {
  /** Holds the connection and the full ordered migration list. */
  constructor(
    private readonly connection: Database,
    private readonly migrations: Migration[],
  ) {}

  /**
   * Applies pending migrations in order. Each runs in its own transaction and
   * bumps the version inside it, so a failure leaves the database at the last
   * fully applied migration.
   */
  public migrate(): void {
    const current = this.currentVersion();

    // Refuse to run against a database from a newer build
    if (current > this.migrations.length) {
      throw new Error(
        `Database schema version ${current} is newer than this build supports (${this.migrations.length})`,
      );
    }

    // Apply each pending migration atomically with its version bump
    for (const [index, migration] of this.migrations.entries()) {
      const version = index + 1;
      if (version <= current) continue;

      this.connection.transaction(() => {
        for (const statement of migration.statements) this.connection.run(statement);
        this.connection.run(`PRAGMA user_version = ${version}`);
      })();

      console.log(`[Database] Applied migration ${version}: ${migration.name}`);
    }
  }

  /** The highest migration version already applied. */
  private currentVersion(): number {
    const row = this.connection.query<{ user_version: number }, []>("PRAGMA user_version").get();
    return row?.user_version ?? 0;
  }
}
