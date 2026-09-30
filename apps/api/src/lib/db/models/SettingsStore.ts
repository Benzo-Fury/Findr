/**
 * The database settings store. Each section of `Settings` is one row holding
 * a JSON document, so updating the watchdog never rewrites the naming
 * templates, and a new field added to a section picks up its default without
 * a migration.
 *
 * Reads always go to the database — settings are tiny and read at the start
 * of each unit of work, so a change on the settings page applies to the next
 * download without a restart.
 */

import {
  SettingsSchema,
  type Settings,
  type SettingsPatch,
  type SettingsSection,
} from "@findr/types/settings";
import { Model } from "./Model";

// ---------- Rows ---------- //

/** A `settings` row as stored. `value` is one section as JSON. */
interface SettingsRow {
  key: string;
  value: string;
}

// ---------- Store ---------- //

export class SettingsStore extends Model {
  /**
   * The current settings, with defaults filled in for anything unset. A
   * stored section that no longer validates — say, after a schema change —
   * falls back to its defaults with a warning rather than blocking startup.
   */
  public static load(): Settings {
    const stored = this.readSections();

    // Validate each section on its own so one bad section cannot sink the rest
    const sections: Record<string, unknown> = {};
    for (const key of Object.keys(SettingsSchema.shape) as SettingsSection[]) {
      const candidate = SettingsSchema.shape[key].safeParse(stored[key] ?? {});
      if (candidate.success) {
        sections[key] = candidate.data;
      } else {
        console.warn(`[Settings] Stored "${key}" settings are invalid; using defaults`);
      }
    }

    return SettingsSchema.parse(sections);
  }

  /**
   * Applies a partial update. Fields present in the patch replace the stored
   * ones; the merged result is validated as a whole before anything is
   * written, so an invalid patch changes nothing.
   */
  public static update(patch: SettingsPatch): Settings {
    const current = this.load();

    // Merge field by field within each patched section
    const merged: Settings = {
      paths: { ...current.paths, ...patch.paths },
      naming: { ...current.naming, ...patch.naming },
      preferences: { ...current.preferences, ...patch.preferences },
      queue: { ...current.queue, ...patch.queue },
      watchdog: { ...current.watchdog, ...patch.watchdog },
      llmFilter: { ...current.llmFilter, ...patch.llmFilter },
    };
    const next = SettingsSchema.parse(merged);

    // Persist only the sections the patch touched
    const upsert = this.db.query(
      `INSERT INTO settings (key, value, updated_at) VALUES ($key, $value, $now)
       ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
    );
    this.transaction(() => {
      for (const key of Object.keys(patch) as SettingsSection[]) {
        upsert.run({ key, value: JSON.stringify(next[key]), now: Date.now() });
      }
    });

    return next;
  }

  /** Every stored section, parsed from JSON but not yet validated. */
  private static readSections(): Record<string, unknown> {
    const rows = this.db.query<SettingsRow, []>("SELECT key, value FROM settings").all();
    return Object.fromEntries(rows.map((row) => [row.key, JSON.parse(row.value) as unknown]));
  }
}
