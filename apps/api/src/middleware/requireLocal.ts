/**
 * Turns away requests from other machines unless remote access is enabled in
 * the settings. Runs ahead of everything, the web app included, so a fresh
 * install — still on its initial `admin` / `admin` credentials — is reachable
 * only from the server itself.
 *
 * Remote access can only be switched on from the settings page, which an
 * account still on its initial credentials cannot reach, so it never opens
 * before those credentials are replaced.
 *
 * There are two exceptions: a TV on the local network fetching media it was
 * cast, with a valid token in the URL (`CastAccess`); and, while a fresh
 * install is still unclaimed, the web app and the claim route, which only
 * act with the setup code from the server's log (`SetupCode`).
 */

import type { MiddlewareHandler } from "hono"
import { SettingsStore } from "../lib/db/models/SettingsStore"
import { CastAccess } from "../lib/playback/CastAccess"
import { ClientAddress } from "../lib/server/ClientAddress"
import { SetupCode } from "../lib/setup/SetupCode"

export const requireLocal: MiddlewareHandler = async (c, next) => {
  if (ClientAddress.isLocal(c) || SettingsStore.section("access").allowRemote || CastAccess.allows(c) || SetupCode.allows(c)) {
    await next()
    return
  }

  // API callers get the usual error shape; a browser gets a readable page
  if (c.req.path.startsWith("/api/")) {
    return c.json({ error: "remote_access_disabled" }, 403)
  }
  return c.text("Remote access is disabled. Sign in from the server itself and enable it on the Settings page.", 403)
}
