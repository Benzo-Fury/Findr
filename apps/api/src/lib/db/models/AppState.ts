/**
 * Internal state Findr keeps between restarts that is not a user setting —
 * for example the torrent client's known DHT nodes. Each key holds one JSON
 * document. Values come back as `unknown`: the caller owns the shape and
 * validates it, since a stored document may predate a code change.
 */

import { Model } from "./Model";

// ---------- Rows ---------- //

/** An `app_state` row as stored. */
interface AppStateRow {
  value: string;
}

// ---------- Store ---------- //

export class AppState extends Model {
  /** The stored value for a key, or null when unset or unreadable. */
  public static get(key: string): unknown {
    const row = this.db
      .query<AppStateRow, { key: string }>("SELECT value FROM app_state WHERE key = $key")
      .get({ key });
    if (!row) return null;

    // A corrupt document reads as unset rather than failing the caller
    try {
      return JSON.parse(row.value) as unknown;
    } catch {
      return null;
    }
  }

  /** Stores a JSON-serialisable value under a key, replacing any previous one. */
  public static set(key: string, value: unknown): void {
    this.db
      .query(
        `INSERT INTO app_state (key, value, updated_at) VALUES ($key, $value, $now)
         ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
      )
      .run({ key, value: JSON.stringify(value), now: Date.now() });
  }
}
