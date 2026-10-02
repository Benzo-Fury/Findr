/**
 * Works out where a request came from. Shared by the rate limiter, which
 * needs a stable key per client, and the remote access check, which needs to
 * know whether the client is this machine.
 *
 * The socket address is the only thing the server can verify. Forwarding
 * headers are written by whoever sent the request, so they are believed only
 * with `TRUST_PROXY` set — and their mere presence on a loopback connection
 * means a local reverse proxy is relaying someone else.
 */

import type { Context } from "hono"
import { getConnInfo } from "hono/bun"
import { env } from "../env/Env"

/** Headers a reverse proxy adds to say who it is relaying for. */
const FORWARDING_HEADERS = ["x-forwarded-for", "forwarded", "x-real-ip"] as const

export class ClientAddress {
  /**
   * A key identifying the client for rate limiting: the first forwarded hop
   * behind a trusted proxy, otherwise the socket address.
   */
  public static key(c: Context): string {
    if (env.TRUST_PROXY) {
      const forwarded = this.forwardedFor(c)
      if (forwarded) return forwarded
    }

    // Requests not served by Bun.serve (tests calling fetch directly) have no socket
    const socket = this.socket(c)
    if (socket === null) return "local"
    return socket || "unknown"
  }

  /**
   * Whether the request comes from this machine. The connection must be
   * loopback; if a proxy on this machine forwarded it, the forwarded client
   * must be loopback too, and is only believed with `TRUST_PROXY` set.
   * Anything uncertain counts as remote.
   */
  public static isLocal(c: Context): boolean {
    // In-process requests (tests calling fetch directly) never touched the network
    const socket = this.socket(c)
    if (socket === null) return true
    if (!this.isLoopback(socket)) return false

    // A loopback connection carrying forwarding headers is a proxy relaying a client
    const forwarded = FORWARDING_HEADERS.some((name) => c.req.header(name) !== undefined)
    if (!forwarded) return true
    if (!env.TRUST_PROXY) return false

    const client = this.forwardedFor(c)
    return client !== null && this.isLoopback(client)
  }

  /**
   * The socket's remote address; empty when the server could not tell, and
   * null when the request was handed to the app in-process rather than
   * served by `Bun.serve`.
   */
  private static socket(c: Context): string | null {
    try {
      return getConnInfo(c).remote.address ?? ""
    } catch {
      return null
    }
  }

  /** The first hop of `X-Forwarded-For`, which a trusted proxy sets to the real client. */
  private static forwardedFor(c: Context): string | null {
    return c.req.header("x-forwarded-for")?.split(",")[0]?.trim() || null
  }

  /** Whether an address is the IPv4 or IPv6 loopback, including IPv4-mapped forms. */
  private static isLoopback(address: string): boolean {
    const ip = address.toLowerCase().replace(/^::ffff:/, "")
    return ip === "::1" || /^127(\.\d{1,3}){3}$/.test(ip)
  }
}
