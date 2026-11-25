/**
 * Lets TVs on the local network fetch media while remote access is off. A
 * Chromecast, Apple TV or DLNA renderer is another machine, so `requireLocal`
 * would turn it away; this lets through exactly the requests it makes:
 * media paths carrying a valid stream token or cast ticket, and the splash
 * shown on a TV picked to cast to, from a private address, while playback
 * and casting are both on. Every other path still needs remote access.
 */

import type { Context } from "hono";
import { SettingsStore } from "../db/models/SettingsStore";
import { CastTicket } from "./CastTicket";
import { LocalNetwork } from "./LocalNetwork";
import { StreamToken } from "./StreamToken";

/** `/api/playback/stream/<token>/<file>` and `/api/playback/cast/<ticket>/<file>`. */
const MEDIA_PATH = /^\/api\/playback\/(stream|cast)\/([^/]+)\/[^/]+$/;

export class CastAccess {
  /** Where TVs fetch the splash shown while one is picked to cast to. */
  public static readonly SPLASH_PATH = "/api/playback/splash";

  /** Whether a request from another machine is a TV fetching media it was given. */
  public static allows(c: Context): boolean {
    const match = MEDIA_PATH.exec(c.req.path);
    const splash = c.req.path === CastAccess.SPLASH_PATH;
    if (!match && !splash) return false;

    const settings = SettingsStore.section("playback");
    if (!settings.enabled || !settings.casting || !LocalNetwork.includes(c)) return false;
    if (!match) return true;

    const credential = decodeURIComponent(match[2] ?? "");
    return match[1] === "stream" ? StreamToken.verify(credential) !== null : CastTicket.verify(credential) !== null;
  }
}
