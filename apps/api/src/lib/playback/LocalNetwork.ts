/**
 * Tells whether a client address belongs to the local network: loopback,
 * the private IPv4 ranges, link-local, and IPv6 unique-local addresses.
 * Playback applies its remote bitrate cap only to clients outside these.
 */

import type { Context } from "hono";
import { ClientAddress } from "../server/ClientAddress";

export class LocalNetwork {
  /** Whether the request comes from this machine or the local network. */
  public static includes(c: Context): boolean {
    const address = ClientAddress.key(c);
    // Requests handed in-process, as in tests, never left the machine
    if (address === "local") return true;
    return this.isPrivate(address);
  }

  /** Whether an IPv4 or IPv6 address is loopback, private or link-local. */
  public static isPrivate(address: string): boolean {
    const ip = address.toLowerCase().replace(/^::ffff:/, "");

    // IPv4: loopback, 10/8, 172.16/12, 192.168/16, 169.254/16
    const v4 = /^(\d{1,3})\.(\d{1,3})\.\d{1,3}\.\d{1,3}$/.exec(ip);
    if (v4) {
      const a = Number(v4[1]);
      const b = Number(v4[2]);
      return a === 127 || a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 169 && b === 254);
    }

    // IPv6: loopback, unique-local fc00::/7, link-local fe80::/10
    return ip === "::1" || /^f[cd][0-9a-f]{2}:/.test(ip) || /^fe[89ab][0-9a-f]:/.test(ip);
  }
}
