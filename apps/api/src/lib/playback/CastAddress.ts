/**
 * Works out the address a TV on the local network can fetch media from. A
 * cast receiver or DLNA renderer is handed an absolute URL, and `localhost`
 * means the TV itself, so the address must be one the TV can reach: the
 * `castBaseUrl` setting when it is set, otherwise this machine's address on
 * the local network and the port Findr listens on.
 */

import { networkInterfaces } from "node:os";
import { SettingsStore } from "../db/models/SettingsStore";
import { ServerAddress } from "../server/ServerAddress";
import { LocalNetwork } from "./LocalNetwork";

/**
 * Interfaces that are never the local network: VPN tunnels, container and
 * VM bridges, and Apple's peer-to-peer links.
 */
const VIRTUAL_INTERFACE = /^(utun|tun|tap|wg|ppp|ipsec|docker|br-|veth|virbr|vboxnet|vmnet|bridge|llw|awdl|anpi|zt|tailscale)/i;

/** Physical interfaces, preferred in this order when several qualify. */
const PREFERRED_INTERFACE = [/^en\d/i, /^eth\d/i, /^wl/i, /^e/i];

export class CastAddress {
  /** The base URL TVs fetch from, without a trailing slash; null when there is no usable address. */
  public static baseUrl(): string | null {
    const configured = SettingsStore.section("playback").castBaseUrl;
    if (configured) return configured.replace(/\/+$/, "");
    const address = this.lanAddress();
    return address ? `http://${address}:${ServerAddress.port}` : null;
  }

  /**
   * This machine's private IPv4 address on a physical interface. IPv6 and
   * link-local addresses are skipped: TVs handle them poorly.
   */
  public static lanAddress(): string | null {
    const candidates: Array<{ name: string; address: string }> = [];
    for (const [name, addresses] of Object.entries(networkInterfaces())) {
      if (VIRTUAL_INTERFACE.test(name)) continue;
      for (const entry of addresses ?? []) {
        if (entry.internal || entry.family !== "IPv4") continue;
        if (!LocalNetwork.isPrivate(entry.address) || entry.address.startsWith("169.254.") || entry.address.startsWith("127.")) continue;
        candidates.push({ name, address: entry.address });
      }
    }

    // Wired and Wi-Fi interfaces before anything else
    const rank = (name: string) => {
      const index = PREFERRED_INTERFACE.findIndex((pattern) => pattern.test(name));
      return index === -1 ? PREFERRED_INTERFACE.length : index;
    };
    candidates.sort((a, b) => rank(a.name) - rank(b.name) || a.name.localeCompare(b.name));
    return candidates[0]?.address ?? null;
  }
}
