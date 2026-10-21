/**
 * Finds DLNA media renderers on the local network with an SSDP search: an
 * M-SEARCH multicast to 239.255.255.250:1900, answered by every renderer
 * with the URL of its device description. The socket is bound to the local
 * network address so the search leaves through the LAN even when a VPN holds
 * the default route.
 *
 * Anything on the network can answer, so an answer counts only when its URL
 * is on the device that sent it: otherwise one device could have Findr fetch
 * from, and send commands to, any address it names, this machine included.
 */

import { createSocket } from "node:dgram";
import { release, type } from "node:os";
import { version as packageVersion } from "../../../../../../package.json";

/** The SSDP multicast group and port. */
const SSDP_ADDRESS = "239.255.255.250";
const SSDP_PORT = 1900;

/** Who is searching, in the form UPnP Device Architecture 1.1 gives: `OS/version UPnP/1.1 product/version`. */
const USER_AGENT = `${type()}/${release()} UPnP/1.1 Findr/${process.env.FINDR_VERSION ?? packageVersion}`;

/** The device type every DLNA renderer advertises. */
export const MEDIA_RENDERER = "urn:schemas-upnp-org:device:MediaRenderer:1";

export class Ssdp {
  /**
   * Searches for renderers and resolves with the description URLs that
   * answered within `timeoutMs`. Never rejects; a network that won't carry
   * multicast just finds nothing.
   */
  public static search(localAddress: string | null, timeoutMs = 2500): Promise<Set<string>> {
    return new Promise((resolve) => {
      const locations = new Set<string>();
      const socket = createSocket({ type: "udp4", reuseAddr: true });
      let finished = false;

      const finish = () => {
        if (finished) return;
        finished = true;
        clearTimeout(timer);
        try {
          socket.close();
        } catch {
          // Already closed
        }
        resolve(locations);
      };
      const timer = setTimeout(finish, timeoutMs);

      // Every answer carries a LOCATION header with the description URL, on the device itself
      socket.on("message", (message, sender) => {
        const location = /^location:\s*(\S+)/im.exec(message.toString())?.[1];
        if (location && Ssdp.onDevice(location, sender.address)) locations.add(location);
      });
      socket.on("error", (error) => {
        console.warn("[Playback] DLNA search failed:", error.message);
        finish();
      });

      socket.bind(0, localAddress ?? undefined, () => {
        try {
          if (localAddress) socket.setMulticastInterface(localAddress);
          socket.setMulticastTTL(2);
        } catch {
          // The default interface will do
        }
        const request = [
          "M-SEARCH * HTTP/1.1",
          `HOST: ${SSDP_ADDRESS}:${SSDP_PORT}`,
          'MAN: "ssdp:discover"',
          "MX: 2",
          `ST: ${MEDIA_RENDERER}`,
          `USER-AGENT: ${USER_AGENT}`,
          "",
          "",
        ].join("\r\n");

        // UDP gets lost; ask twice
        const send = () => {
          if (!finished) socket.send(request, SSDP_PORT, SSDP_ADDRESS, () => {});
        };
        send();
        setTimeout(send, 400);
      });
    });
  }

  /** Whether a URL is plain HTTP(S) on the given address. */
  public static onDevice(url: string, address: string): boolean {
    try {
      const parsed = new URL(url);
      return (parsed.protocol === "http:" || parsed.protocol === "https:") && parsed.hostname === address;
    } catch {
      return false;
    }
  }
}
