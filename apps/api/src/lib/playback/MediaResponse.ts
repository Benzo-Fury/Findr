/**
 * Writes the responses for session media, shared by the stream and cast
 * routes: the HLS playlist, init section and segments, and a DLNA session's
 * single stream. Every response allows any origin, because a Cast receiver
 * fetches from its own page's origin; the token or ticket in the path is the
 * credential, never a cookie.
 */

import type { Context } from "hono";
import { MEDIA_PLAYLIST, PlaybackSession, SegmentUnavailableError } from "./PlaybackSession";
import type { ProgressiveSession } from "./ProgressiveSession";

/** The part of Bun's server Hono passes as the context's env. */
interface BunServer {
  timeout?(request: Request, seconds: number): void;
}

/** Headers every media response carries. */
const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, HEAD, OPTIONS",
  "Access-Control-Allow-Headers": "Range, Content-Type",
  "Access-Control-Expose-Headers": "Content-Length, Content-Range",
};

export class MediaResponse {
  /** The answer to a CORS preflight. */
  public static preflight(): Response {
    return new Response(null, { status: 204, headers: { ...CORS_HEADERS, "Access-Control-Max-Age": "86400" } });
  }

  /** A JSON error that receivers on other origins can still read. */
  public static error(code: string, status: 404 | 503): Response {
    return Response.json({ error: code }, { status, headers: CORS_HEADERS });
  }

  /** Serves the multivariant `index.m3u8`, the media playlist, `init.mp4` or `<n>.m4s` of an HLS session. */
  public static async hls(c: Context, session: PlaybackSession, file: string): Promise<Response> {
    try {
      if (file === "index.m3u8") return this.playlist(session.multivariantPlaylist());
      if (file === MEDIA_PLAYLIST) return this.playlist(session.playlist());

      // A segment not yet produced is waited for, which can outlast Bun's ten-second idle timeout
      this.allowSlow(c, 120);
      if (file === "init.mp4") return this.file(await session.init(), "video/mp4");
      const segment = /^(\d+)\.m4s$/.exec(file);
      if (segment) return this.file(await session.segment(Number(segment[1])), "video/iso.segment");
      return this.error("not_found", 404);
    } catch (error) {
      // The player retries a segment that a seek or a failed run left unproduced
      if (error instanceof SegmentUnavailableError) return this.error("segment_unavailable", 503);
      throw error;
    }
  }

  /** Serves a DLNA session's stream, positioned by `?start=` in milliseconds. */
  public static progressive(c: Context, session: ProgressiveSession, file: string): Response {
    if (file !== session.fileName) return this.error("not_found", 404);
    // A paused renderer stops reading for as long as it likes
    this.allowSlow(c, 0);
    const start = Number(c.req.query("start") ?? 0);
    const response = session.serve(c.req.raw, Number.isFinite(start) && start > 0 ? Math.floor(start) : 0);
    for (const [name, value] of Object.entries(CORS_HEADERS)) response.headers.set(name, value);
    return response;
  }

  /** Whether a session is the HLS kind. */
  public static isHls(session: PlaybackSession | ProgressiveSession): session is PlaybackSession {
    return session instanceof PlaybackSession;
  }

  /** A playlist, never cached: a resumed session's start point is in it. */
  private static playlist(text: string): Response {
    return new Response(text, { headers: { ...CORS_HEADERS, "Content-Type": "application/vnd.apple.mpegurl", "Cache-Control": "no-store" } });
  }

  /** A file the session has written. */
  private static file(path: string, type: string): Response {
    return new Response(Bun.file(path), { headers: { ...CORS_HEADERS, "Content-Type": type, "Cache-Control": "private, max-age=3600" } });
  }

  /** Lets this request outlive Bun's idle timeout; 0 lifts it entirely. */
  public static allowSlow(c: Context, seconds: number): void {
    const server = c.env as BunServer | undefined;
    server?.timeout?.(c.req.raw, seconds);
  }
}
