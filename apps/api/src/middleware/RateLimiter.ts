/**
 * Fixed-window, in-memory rate limiting per route and client.
 *
 * Clients are identified by IP address — taken from the socket, or from the
 * first `X-Forwarded-For` hop when `TRUST_PROXY` is set. Each route has its
 * own budget, so a burst on one endpoint does not starve the others. State is
 * per process, which suits a single self-hosted server.
 */

import type { Context, MiddlewareHandler } from "hono"
import { getConnInfo } from "hono/bun"
import { env } from "../lib/env/Env"

/** A route's allowance: `max` requests per `window` seconds. */
export interface RateLimit {
  max: number
  window: number
}

/** One client's usage of one route within the current window. */
interface Bucket {
  count: number
  resetsAt: number
}

/** How often expired buckets are swept, so memory stays bounded. */
const SWEEP_INTERVAL_MS = 60_000

export class RateLimiter {
  private readonly buckets = new Map<string, Bucket>()

  constructor() {
    // Drop expired buckets periodically; unref so tests and shutdown are not held open
    setInterval(() => this.sweep(), SWEEP_INTERVAL_MS).unref()
  }

  /** Middleware enforcing `limit` on one route, identified by its path pattern. */
  public forRoute(route: string, limit: RateLimit): MiddlewareHandler {
    return async (c, next) => {
      const key = `${route}|${this.clientKey(c)}`
      const now = Date.now()

      // Start a new window, or count against the current one
      let bucket = this.buckets.get(key)
      if (!bucket || bucket.resetsAt <= now) {
        bucket = { count: 0, resetsAt: now + limit.window * 1000 }
        this.buckets.set(key, bucket)
      }
      bucket.count += 1

      // Over budget: tell the client when to come back
      const retryAfter = Math.ceil((bucket.resetsAt - now) / 1000)
      c.header("RateLimit-Limit", String(limit.max))
      c.header("RateLimit-Remaining", String(Math.max(0, limit.max - bucket.count)))
      if (bucket.count > limit.max) {
        c.header("Retry-After", String(retryAfter))
        return c.json({ error: "rate_limited" }, 429)
      }

      await next()
    }
  }

  /** The client's address, honouring a trusted proxy's forwarding header. */
  private clientKey(c: Context): string {
    if (env.TRUST_PROXY) {
      const forwarded = c.req.header("x-forwarded-for")?.split(",")[0]?.trim()
      if (forwarded) return forwarded
    }

    try {
      return getConnInfo(c).remote.address ?? "unknown"
    } catch {
      // Requests not served by Bun.serve (tests calling fetch directly) have no socket
      return "local"
    }
  }

  /** Removes buckets whose window has ended. */
  private sweep(): void {
    const now = Date.now()
    for (const [key, bucket] of this.buckets) {
      if (bucket.resetsAt <= now) this.buckets.delete(key)
    }
  }
}
