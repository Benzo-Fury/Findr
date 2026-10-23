/**
 * Keeps track of cast bridges' connections: one `BridgedRendererNetwork` per
 * bridge that has connected since the server started, which the DLNA
 * controller searches and drives alongside the server's own network.
 */

import type { CastBridgeRecord } from "@findr/types/playback";
import type { CastBridge } from "../../db/models/CastBridge";
import SelfManagedSingleton from "../../other/SelfManagedSingleton";
import { type BridgeSocket, BridgedRendererNetwork } from "./BridgedRendererNetwork";

export default class BridgeHub extends SelfManagedSingleton {
  private readonly bridges = new Map<string, BridgedRendererNetwork>();

  /** Takes a bridge's new connection, returning the network it now serves. */
  public connect(bridge: CastBridge, socket: BridgeSocket): BridgedRendererNetwork {
    let network = this.bridges.get(bridge.id);
    if (!network) {
      network = new BridgedRendererNetwork(bridge.id, bridge.name);
      this.bridges.set(bridge.id, network);
    }
    network.place = bridge.name;
    network.attach(socket);
    bridge.touch();
    return network;
  }

  /** Every bridge's network, connected or not. */
  public networks(): BridgedRendererNetwork[] {
    return [...this.bridges.values()];
  }

  /** A bridge's network, if it has connected since the server started. */
  public get(bridgeId: string): BridgedRendererNetwork | null {
    return this.bridges.get(bridgeId) ?? null;
  }

  /** A bridge as the settings page lists it, with its connection as it stands. */
  public record(bridge: CastBridge, renderers: number): CastBridgeRecord {
    const network = this.bridges.get(bridge.id);
    const online = network?.connected ?? false;
    return bridge.toRecord({ online, version: network?.version ?? null, address: online ? (network?.mediaBase() ?? null) : null, renderers });
  }

  /** Disconnects a removed bridge and forgets it. */
  public remove(bridgeId: string): void {
    this.bridges.get(bridgeId)?.close();
    this.bridges.delete(bridgeId);
  }
}
