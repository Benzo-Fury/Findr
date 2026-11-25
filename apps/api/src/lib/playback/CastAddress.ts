/**
 * Works out the address a TV can fetch media from. A cast receiver or DLNA
 * renderer is handed an absolute URL, and `localhost` means the TV itself, so
 * the address must be one the TV can reach.
 *
 * A TV on the server's own network uses the `castBaseUrl` setting when it is
 * set, otherwise this machine's address on the local network and the port
 * Findr listens on. A Google Cast or AirPlay receiver sits beside the browser
 * that cast to it, so when that browser is somewhere else, its TV fetches
 * from the address the outside world reaches Findr at instead.
 */

import { SettingsStore } from "../db/models/SettingsStore";
import { ServerAddress } from "../server/ServerAddress";
import { LanInterface } from "./LanInterface";
import { LocalNetwork } from "./LocalNetwork";

export class CastAddress {
  /** The base URL TVs on the server's network fetch from, without a trailing slash; null when there is no usable address. */
  public static baseUrl(): string | null {
    const configured = this.configured();
    if (configured) return configured;
    const address = LanInterface.address();
    return address ? `http://${address}:${ServerAddress.port}` : null;
  }

  /**
   * The base URL for a TV beside a client: the local one for a client on the
   * server's network; otherwise the public URL, or `castBaseUrl` when that is
   * an address outside the local network. Null when nothing outside can reach Findr.
   */
  public static forClient(local: boolean): string | null {
    if (local) return this.baseUrl();
    if (ServerAddress.publicOrigin) return ServerAddress.publicOrigin;

    // An address for TVs that is itself public works from anywhere
    const configured = this.configured();
    if (!configured) return null;
    const host = new URL(configured).hostname.replace(/^\[|\]$/g, "");
    return host === "localhost" || host.endsWith(".local") || LocalNetwork.isPrivate(host) ? null : configured;
  }

  /** The `castBaseUrl` setting without a trailing slash, or null when unset. */
  private static configured(): string | null {
    const configured = SettingsStore.section("playback").castBaseUrl;
    return configured ? configured.replace(/\/+$/, "") : null;
  }
}
