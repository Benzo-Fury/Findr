/**
 * Signs the path that playback media is served under. A session's playlist
 * and segments live at `/api/playback/stream/<token>/…`, and the token alone
 * grants access: a player that sends no cookies (a TV fetching a cast URL)
 * can still play, and only for the one session and only until it expires.
 *
 * The key is derived from the auth secret, so tokens die with it, and a
 * token is checked in constant time.
 */

import { createHmac, timingSafeEqual } from "node:crypto";
import { client } from "../db/client";
import { AuthSecret } from "../auth/AuthSecret";

/** How long a stream URL stays valid. */
const LIFETIME_MS = 12 * 60 * 60 * 1000;

export class StreamToken {
  /** The signing key, derived once from the auth secret. */
  private static key: Buffer | null = null;

  /** A token for one session. */
  public static issue(sessionId: string, now = Date.now()): string {
    const expires = (now + LIFETIME_MS).toString(36);
    return `${sessionId}.${expires}.${this.signature(`${sessionId}.${expires}`)}`;
  }

  /** The session a token grants, or null when it is malformed, forged or expired. */
  public static verify(token: string, now = Date.now()): string | null {
    const [sessionId, expires, signature, extra] = token.split(".");
    if (!sessionId || !expires || !signature || extra !== undefined) return null;

    // Check the signature before trusting anything else
    if (!this.matches(`${sessionId}.${expires}`, signature)) return null;

    const expiresAt = Number.parseInt(expires, 36);
    return Number.isFinite(expiresAt) && expiresAt > now ? sessionId : null;
  }

  /** Whether a signature is the payload's, compared in constant time. */
  public static matches(payload: string, signature: string): boolean {
    const expected = Buffer.from(this.signature(payload));
    const given = Buffer.from(signature);
    return given.length === expected.length && timingSafeEqual(given, expected);
  }

  /** The URL-safe signature of a payload. */
  public static signature(payload: string): string {
    this.key ??= createHmac("sha256", AuthSecret.load(client.directory)).update("findr:playback-stream").digest();
    return createHmac("sha256", this.key).update(payload).digest("base64url").slice(0, 32);
  }
}
