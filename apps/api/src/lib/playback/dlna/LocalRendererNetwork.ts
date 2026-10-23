/**
 * The server's own network: renderers found by an SSDP search from this
 * machine, driven directly, fetching media from the address `CastAddress`
 * works out.
 */

import { CastAddress } from "../CastAddress";
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
}
