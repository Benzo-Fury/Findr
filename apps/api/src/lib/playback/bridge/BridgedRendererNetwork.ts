/**
 * The network a cast bridge is on, as the server sees it: searches and TV
 * requests are sent down the bridge's WebSocket and answered by the bridge,
 * Cast connections are held by the bridge and relayed over the same socket,
 * and TVs fetch media from the bridge's own proxy, which passes it on from
 * the server. One stands for each bridge for as long as the server runs, so
 * a bridge that reconnects finds its TVs as they were.
 */

import type { HttpExchange, HttpReply, RendererNetwork } from "../dlna/RendererNetwork";
import type { CastDevice, CastLink } from "../googlecast/CastLink";
import type { CastFrame } from "../googlecast/CastMessage";
import {
  BRIDGE_PROTOCOL,
  BridgeMessageSchema,
  CastOpenResultSchema,
  CastSearchResultSchema,
  HttpResultSchema,
  SearchResultSchema,
  type ServerMessage,
} from "./BridgeProtocol";

/** The part of a WebSocket the network writes to; Hono's `WSContext` is one. */
export interface BridgeSocket {
  send(data: string): void;
  close(code?: number, reason?: string): void;
}

/** A question sent to the bridge, waiting for its reply. */
interface Pending {
  resolve: (result: unknown) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

/** What the bridge said about itself on connecting. */
interface Hello {
  version: string;
  mediaBase: string | null;
}

/** How long a bridge gets to search: its SSDP or mDNS search takes 2.5 seconds, then the answer travels. */
const SEARCH_TIMEOUT_MS = 10_000;

/** How long a bridge gets to connect to a Cast device. */
const CAST_OPEN_TIMEOUT_MS = 10_000;

// ---------- Relayed Cast connection ---------- //

/** A Cast connection the bridge holds, as the server uses it. */
class BridgedCastLink implements CastLink {
  public onMessage: ((frame: CastFrame) => void) | null = null;
  public onClose: (() => void) | null = null;
  private ended = false;

  constructor(
    private readonly network: BridgedRendererNetwork,
    /** The bridge's id for the connection. */
    public readonly channel: string,
  ) {}

  public get closed(): boolean {
    return this.ended;
  }

  public send(frame: CastFrame): void {
    if (!this.ended) this.network.relay({ type: "castSend", channel: this.channel, frame });
  }

  public close(): void {
    if (this.ended) return;
    this.network.relay({ type: "castClose", channel: this.channel });
    this.finish();
  }

  /** Ends the link from the bridge's side, or as the bridge goes away. */
  public finish(): void {
    if (this.ended) return;
    this.ended = true;
    this.network.forgetLink(this.channel);
    this.onClose?.();
  }
}

// ---------- Network ---------- //

/** Time allowed on top of a TV request's own timeout for the round trip to the bridge. */
const RELAY_MARGIN_MS = 5000;

export class BridgedRendererNetwork implements RendererNetwork {
  public readonly local = false;
  /** The bridge's name, kept up to date as it reconnects. */
  public place: string;

  private socket: BridgeSocket | null = null;
  private hello: Hello | null = null;
  private readonly pending = new Map<string, Pending>();
  /** Open Cast connections, by the bridge's channel id. */
  private readonly links = new Map<string, BridgedCastLink>();
  private nextId = 0;

  constructor(
    public readonly id: string,
    place: string,
  ) {
    this.place = place;
  }

  // ---------- Connection ---------- //

  /** Whether the bridge is connected and has said hello. */
  public get connected(): boolean {
    return this.socket !== null && this.hello !== null;
  }

  /** The Findr version the bridge runs, while connected. */
  public get version(): string | null {
    return this.hello?.version ?? null;
  }

  /** Takes a new connection from the bridge, closing any older one it replaces. */
  public attach(socket: BridgeSocket): void {
    const previous = this.socket;
    this.drop(new Error("bridge reconnected"));
    this.socket = socket;
    previous?.close(4000, "replaced by a newer connection");
  }

  /** Forgets a connection that closed, unless a newer one has replaced it. */
  public detach(socket: BridgeSocket): void {
    if (this.socket !== socket) return;
    this.drop(new Error("bridge disconnected"));
    this.socket = null;
  }

  /** Closes the connection for good, as when the bridge is removed. */
  public close(): void {
    const socket = this.socket;
    this.drop(new Error("bridge removed"));
    this.socket = null;
    socket?.close(4001, "bridge removed");
  }

  /** Handles a frame from the bridge; a frame it can't read closes the connection. */
  public receive(socket: BridgeSocket, data: string): void {
    if (this.socket !== socket) return;
    let message;
    try {
      message = BridgeMessageSchema.parse(JSON.parse(data));
    } catch {
      // Dropped rather than removed: the bridge reconnects instead of giving up
      console.warn(`[Playback] Cast bridge ${this.place} sent something unreadable; disconnecting it`);
      this.drop(new Error("bridge sent something unreadable"));
      this.socket = null;
      socket.close(1008, "unreadable message");
      return;
    }

    switch (message.type) {
      // A bridge too old or too new to understand is turned away
      case "hello":
        if (message.protocol !== BRIDGE_PROTOCOL) {
          console.warn(`[Playback] Cast bridge ${this.place} runs Findr ${message.version}, which this server can't drive; update both to the same version`);
          socket.close(4002, "protocol mismatch");
          return;
        }
        this.hello = { version: message.version, mediaBase: message.mediaBase };
        console.log(`[Playback] Cast bridge ${this.place} connected (Findr ${message.version}; TVs fetch from ${message.mediaBase ?? "nowhere: it has no local address"})`);
        return;

      // Settle the question this answers
      case "reply": {
        const pending = this.pending.get(message.id);
        if (!pending) return;
        this.pending.delete(message.id);
        clearTimeout(pending.timer);
        if (message.ok) pending.resolve(message.result);
        else pending.reject(new Error(message.error ?? "the bridge couldn't do it"));
        return;
      }

      case "ping":
        return;

      // Cast connections the bridge holds
      case "castMessage":
        this.links.get(message.channel)?.onMessage?.(message.frame);
        return;
      case "castClosed":
        this.links.get(message.channel)?.finish();
        return;
    }
  }

  // ---------- RendererNetwork ---------- //

  /** Asks the bridge to search its network; finds nothing while it is away or slow. */
  public async search(): Promise<Set<string>> {
    try {
      return new Set(SearchResultSchema.parse(await this.ask({ type: "search", id: "" }, SEARCH_TIMEOUT_MS)));
    } catch (error) {
      console.warn(`[Playback] Cast bridge ${this.place} couldn't search: ${error instanceof Error ? error.message : String(error)}`);
      return new Set();
    }
  }

  public async request(exchange: HttpExchange): Promise<HttpReply> {
    return HttpResultSchema.parse(await this.ask({ type: "http", id: "", exchange }, exchange.timeoutMs + RELAY_MARGIN_MS));
  }

  public mediaBase(): string | null {
    return this.hello?.mediaBase ?? null;
  }

  /** Asks the bridge to search its network for Cast devices; finds nothing while it is away or slow. */
  public async searchCast(): Promise<CastDevice[]> {
    try {
      return CastSearchResultSchema.parse(await this.ask({ type: "castSearch", id: "" }, SEARCH_TIMEOUT_MS));
    } catch (error) {
      console.warn(`[Playback] Cast bridge ${this.place} couldn't search for Cast devices: ${error instanceof Error ? error.message : String(error)}`);
      return [];
    }
  }

  /** Has the bridge connect to a Cast device it found, relaying the connection from then on. */
  public async openCast(device: CastDevice): Promise<CastLink> {
    const { channel } = CastOpenResultSchema.parse(await this.ask({ type: "castOpen", id: "", device: { host: device.host, port: device.port } }, CAST_OPEN_TIMEOUT_MS));
    const link = new BridgedCastLink(this, channel);
    this.links.set(channel, link);
    return link;
  }

  /** Sends a message that wants no reply; dropped while the bridge is away. */
  public relay(message: ServerMessage): void {
    try {
      if (this.connected) this.socket?.send(JSON.stringify(message));
    } catch {
      // The connection is going; its links are ended with it
    }
  }

  /** Forgets a Cast link that has ended. */
  public forgetLink(channel: string): void {
    this.links.delete(channel);
  }

  // ---------- Inner workings ---------- //

  /** Sends a question to the bridge and waits for its reply. */
  private ask(message: ServerMessage, timeoutMs: number): Promise<unknown> {
    const socket = this.socket;
    if (!socket || !this.hello) return Promise.reject(new Error("bridge not connected"));
    const id = String(++this.nextId);

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error("the bridge didn't answer in time"));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      try {
        socket.send(JSON.stringify({ ...message, id }));
      } catch (error) {
        this.pending.delete(id);
        clearTimeout(timer);
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  /** Fails every question still waiting and forgets the hello, as a connection ends. */
  private drop(reason: Error): void {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(reason);
    }
    this.pending.clear();
    this.hello = null;
    // The bridge closes its Cast connections as the socket goes
    for (const link of [...this.links.values()]) link.finish();
  }
}
