/**
 * An admin's corrections to what a DLNA renderer says it plays, one JSON
 * document per renderer id, validated on the way out so a document written
 * by an older build still reads. TVs list containers rather than codecs, and
 * almost never say whether they show HDR, so these are how a 4K HDR TV gets
 * the file as it is.
 */

import { RendererOverridesSchema, type RendererOverrides } from "@findr/types/playback";
import { Model } from "./Model";

// ---------- Rows ---------- //

/** A `renderer_overrides` row as stored. */
interface OverrideRow {
  value: string;
}

/** No corrections: every capability follows what the renderer says. */
export const NO_OVERRIDES: RendererOverrides = { hevc: null, uhd: null, hdr: null };

// ---------- Store ---------- //

export class RendererOverride extends Model {
  /** A renderer's corrections, or none. */
  public static get(rendererId: string): RendererOverrides {
    const row = this.db.query<OverrideRow, { id: string }>("SELECT value FROM renderer_overrides WHERE renderer_id = $id").get({ id: rendererId });
    if (!row) return NO_OVERRIDES;
    try {
      const parsed = RendererOverridesSchema.safeParse(JSON.parse(row.value));
      return parsed.success ? parsed.data : NO_OVERRIDES;
    } catch {
      return NO_OVERRIDES;
    }
  }

  /** Replaces a renderer's corrections; all-null removes them. */
  public static set(rendererId: string, overrides: RendererOverrides): RendererOverrides {
    if (overrides.hevc === null && overrides.uhd === null && overrides.hdr === null) {
      this.db.query("DELETE FROM renderer_overrides WHERE renderer_id = $id").run({ id: rendererId });
      return NO_OVERRIDES;
    }
    this.db
      .query(
        `INSERT INTO renderer_overrides (renderer_id, value, updated_at) VALUES ($id, $value, $now)
         ON CONFLICT (renderer_id) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
      )
      .run({ id: rendererId, value: JSON.stringify(overrides), now: Date.now() });
    return overrides;
  }
}
