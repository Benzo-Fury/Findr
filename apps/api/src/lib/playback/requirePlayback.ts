/**
 * Route middleware that answers every playback route with
 * `playback_disabled` while the feature is switched off, as though it did
 * not exist. The capabilities route leaves it out, so the web app can always
 * ask whether to show playback at all.
 */

import type { MiddlewareHandler } from "hono";
import { SettingsStore } from "../db/models/SettingsStore";

export const requirePlayback: MiddlewareHandler = async (c, next) => {
  if (!SettingsStore.section("playback").enabled) return c.json({ error: "playback_disabled" }, 404);
  await next();
};
