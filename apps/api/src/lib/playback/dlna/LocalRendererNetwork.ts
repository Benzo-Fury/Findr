/**
 * The server's own network: renderers found by an SSDP search and Cast
 * devices by an mDNS query from this machine, driven directly, fetching media
 * from the address `CastAddress` works out.
 */

import { CastAddress } from "../CastAddress";
import { CastChannel } from "../googlecast/CastChannel";
import type { CastDevice, CastLink } from "../googlecast/CastLink";
import { Mdns } from "../googlecast/Mdns";
import { LanInterface } from "../LanInterface";
import { LanHttp } from "./LanHttp";
import type { HttpExchange, HttpReply, RendererNetwork } from "./RendererNetwork";
import { Ssdp } from "./Ssdp";

export class LocalRendererNetwork implements RendererNetwork {
  /** The one instance; there is only one network the server is on. */
  public static readonly instance = new LocalRendererNetwork();

  public readonly id = "local";
  public readonly place = null;
  public readonly local = true;
  public readonly connected = true;

  private constructor() {}

  public search(): Promise<Set<string>> {
    return Ssdp.search(LanInterface.address());
  }

  public request(exchange: HttpExchange): Promise<HttpReply> {
    return LanHttp.request(exchange);
  }

  public mediaBase(): string | null {
    return CastAddress.baseUrl();
  }

  public searchCast(): Promise<CastDevice[]> {
    return Mdns.search(LanInterface.address());
  }

  public openCast(device: CastDevice): Promise<CastLink> {
    return CastChannel.open(device.host, device.port);
  }
}
