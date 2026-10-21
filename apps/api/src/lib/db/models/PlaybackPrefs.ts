/**
 * Each user's playback preferences, one JSON document per user, validated
 * against `PlaybackPrefsSchema` on the way out so a document written by an
 * older build still reads with every field filled in.
 */

import { PlaybackPrefsSchema, type PlaybackPrefs as Prefs } from "@findr/types/playback";
import { Model } from "./Model";

// ---------- Rows ---------- //

/** A `playback_prefs` row as stored. */
interface PrefsRow {
  value: string;
}

// ---------- Store ---------- //

export class PlaybackPrefs extends Model {
  /** A user's preferences, defaults filled in for anything unset or unreadable. */
  public static get(userId: string): Prefs {
    const row = this.db.query<PrefsRow, { userId: string }>("SELECT value FROM playback_prefs WHERE user_id = $userId").get({ userId });

    // A corrupt or outdated document falls back to the defaults field by field
    let stored: unknown = {};
    try {
      stored = row ? (JSON.parse(row.value) as unknown) : {};
    } catch {
      stored = {};
    }
    const parsed = PlaybackPrefsSchema.safeParse(stored);
    return parsed.success ? parsed.data : PlaybackPrefsSchema.parse({});
  }

  /** Replaces a user's preferences. */
  public static set(userId: string, prefs: Prefs): Prefs {
    this.db
      .query(
        `INSERT INTO playback_prefs (user_id, value, updated_at) VALUES ($userId, $value, $now)
         ON CONFLICT (user_id) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
      )
      .run({ userId, value: JSON.stringify(prefs), now: Date.now() });
    return prefs;
  }
}
