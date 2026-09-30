/**
 * Shared response wrapper for the TMDB proxy routes. Every one of them does
 * the same thing — call the client, hand back the JSON, and translate an
 * upstream failure into a 502 — so that handling lives here instead of being
 * repeated in each route file.
 */

import type { Context } from "hono";

/**
 * Runs a TMDB client call and serialises the result. Any thrown error is
 * logged and reported to the client as a bad gateway, since the failure is
 * always upstream rather than in the request itself.
 */
export async function respond<T>(ctx: Context, load: () => Promise<T>) {
  try {
    return ctx.json(await load(), 200);
  } catch (error) {
    console.error("[TMDB] Request failed:", error);
    return ctx.json({ error: "tmdb_unavailable" }, 502);
  }
}
