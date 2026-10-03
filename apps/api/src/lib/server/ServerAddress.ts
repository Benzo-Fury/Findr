/**
 * Where the server listens and which addresses it is reached at. The port and
 * public URL come from the `access` settings, read once at startup, so nobody
 * has to configure a base URL before Findr will run.
 *
 * BetterAuth uses the base URL to decide whether its cookies are `Secure`, and
 * accepts sign-ins and other cookie-carrying requests only from pages whose
 * origin it trusts. That check is what stops another website — including one
 * that rebinds its own hostname to this machine's address — from signing in
 * as the initial `admin` / `admin`, so it is never widened to whatever `Host`
 * a request names.
 */

import { isIP } from "node:net"
import { SettingsStore } from "../db/models/SettingsStore"
import { env } from "../env/Env"

/** The Vite dev server, whose pages call the API through its proxy in development. */
const DEV_ORIGIN = "http://localhost:5173"

export class ServerAddress {
  /** The access settings as they were at startup. */
  private static readonly startup = SettingsStore.section("access")

  /** The port to listen on: the `PORT` override, else the setting. */
  public static readonly port: number = env.PORT ?? this.startup.port

  /** The address Findr is opened at on this machine. */
  public static readonly localUrl = `http://localhost:${this.port}`

  /** The configured public URL's origin, or null when none is set. */
  private static readonly publicOrigin: string | null = this.startup.publicUrl ? new URL(this.startup.publicUrl).origin : null

  /** The origin BetterAuth builds its URLs and cookie policy from. */
  public static readonly baseUrl: string = this.publicOrigin ?? this.localUrl

  /**
   * The origins whose pages may make cookie-carrying requests to BetterAuth:
   * `localhost` on our port, the public URL, and the request's own origin
   * when it was addressed to a bare IP, which is how other machines on the
   * network reach Findr once remote access is on. A hostname is trusted only
   * when it is the public URL: a page can only claim an IP origin if it was
   * served from that IP, but any website can point its hostname at us.
   */
  public static trustedOrigins(request?: Request): string[] {
    const origins = [this.localUrl]
    if (this.publicOrigin) origins.push(this.publicOrigin)
    if (env.NODE_ENV === "development") origins.push(DEV_ORIGIN)

    // Same-origin requests to an IP address, over either protocol a proxy might use
    const host = request?.headers.get("host")
    if (host && this.isIpHost(host)) origins.push(`http://${host}`, `https://${host}`)

    return origins
  }

  /** Whether a `Host` header names an IPv4 or bracketed IPv6 address, with or without a port. */
  private static isIpHost(host: string): boolean {
    const bracketed = /^\[([^\]]+)\](?::\d+)?$/.exec(host)
    if (bracketed) return isIP(bracketed[1] ?? "") === 6
    return isIP(host.replace(/:\d+$/, "")) === 4
  }
}
