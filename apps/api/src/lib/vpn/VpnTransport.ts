/**
 * The torrent engine's network, kept on the VPN while the killswitch is on.
 * TinyTorrent opens every socket it uses — peer connections, the listener,
 * UDP for trackers, the DHT and port mapping, HTTP for trackers and UPnP —
 * through a `Transport`, so binding them all happens here and nowhere else.
 *
 * Every socket asks `VpnGuard.binding()` afresh, so it can only be opened
 * from an address the VPN interface holds at that moment:
 *
 *   killswitch off   the system's own routes, untouched
 *   VPN up           bound to the VPN's address of the matching family
 *                    (a peer's IPv6 address gets the VPN's IPv6 address)
 *   VPN down         `TransportUnavailableError`: nothing is opened
 *
 * Unlike patching `net` and `dgram`, this reaches HTTP trackers too, since
 * the engine makes those requests with `node:http` and a local address.
 */

import type dgram from "node:dgram";
import { isIPv6, type Server, type Socket } from "node:net";
import { boundTransport, systemTransport, type Transport, TransportUnavailableError } from "tinytorrent";
import type VpnGuard from "./VpnGuard";

// ---------- Types ---------- //

/** The parts of `Transport` that are not sockets, taken from it so they stay in step. */
type HttpInit = Parameters<Transport["http"]>[1];
type HttpReply = Awaited<ReturnType<Transport["http"]>>;

// ---------- Transport ---------- //

export class VpnTransport implements Transport {
  private readonly system = systemTransport();

  constructor(private readonly guard: VpnGuard) {}

  public connect(host: string, port: number): Socket {
    return this.route(isIPv6(host) ? 6 : 4).connect(host, port);
  }

  public async listen(port: number, onConnection: (socket: Socket) => void): Promise<Server> {
    return this.route().listen(port, onConnection);
  }

  public async udp(port: number, family?: 4 | 6): Promise<dgram.Socket> {
    return this.route(family).udp(port, family);
  }

  public async httpGet(url: string, timeoutMs: number): Promise<Uint8Array> {
    return this.route().httpGet(url, timeoutMs);
  }

  public async http(url: string, init: HttpInit): Promise<HttpReply> {
    return this.route().http(url, init);
  }

  /** The address sockets are bound to: the VPN's (IPv4 first), or none while the killswitch is off or blocking. */
  public localAddress(): string | undefined {
    try {
      return this.route().localAddress();
    } catch {
      return undefined;
    }
  }

  // ---------- Routing ---------- //

  /**
   * The transport for one new socket: the system's while the killswitch is
   * off, otherwise one bound to the VPN's address for `family` (either, IPv4
   * first, when unspecified). Throws `TransportUnavailableError` while the
   * killswitch blocks traffic or the VPN has no address of that family.
   */
  private route(family?: 4 | 6): Transport {
    // The guard throws while the VPN counts as down; the engine expects its own error
    let binding: ReturnType<VpnGuard["binding"]>;
    try {
      binding = this.guard.binding();
    } catch (error) {
      throw new TransportUnavailableError(error instanceof Error ? error.message : String(error));
    }
    if (!binding) return this.system;

    const address = family === 6 ? binding.ipv6 : family === 4 ? binding.ipv4 : (binding.ipv4 ?? binding.ipv6);
    if (!address) throw new TransportUnavailableError(`The VPN has no IPv${family ?? 4} address to use`);
    return boundTransport({ address });
  }
}
