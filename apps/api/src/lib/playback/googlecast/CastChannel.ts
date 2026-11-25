/**
 * A TLS connection to a Google Cast device on port 8009, carrying length-framed
 * `CastMessage`s. It keeps itself alive: it opens the platform's virtual
 * connection, pings the device every few seconds and answers the device's
 * pings, and closes when the device goes quiet for too long.
 *
 * Cast devices present a self-signed certificate, so it isn't checked; like
 * DLNA, Findr trusts the device that answered its own search on the local
 * network.
 */

import { connect, type TLSSocket } from "node:tls";
import type { CastLink } from "./CastLink";
import { type CastFrame, CastMessage, MAX_FRAME_BYTES } from "./CastMessage";

/** The platform's own namespaces. */
const CONNECTION_NS = "urn:x-cast:com.google.cast.tp.connection";
const HEARTBEAT_NS = "urn:x-cast:com.google.cast.tp.heartbeat";

/** Who Findr is to the device, and who the device's platform is. */
export const SENDER_ID = "sender-findr";
export const PLATFORM_ID = "receiver-0";

/** How often the device is pinged. */
const PING_MS = 5000;

/** A device silent for this long is taken to be gone. */
const SILENCE_MS = 20_000;

/** How long connecting may take. */
const CONNECT_TIMEOUT_MS = 5000;

export class CastChannel implements CastLink {
  public onMessage: ((frame: CastFrame) => void) | null = null;
  public onClose: (() => void) | null = null;

  private buffer = Buffer.alloc(0);
  private lastHeard = Date.now();
  private readonly pinger: ReturnType<typeof setInterval>;
  private ended = false;

  private constructor(private readonly socket: TLSSocket) {
    // Frames in, as they complete
    socket.on("data", (chunk: Buffer) => this.receive(chunk));
    socket.on("close", () => this.finish());
    socket.on("error", () => this.finish());

    // Say hello to the platform, then keep the connection alive
    this.send({ sourceId: SENDER_ID, destinationId: PLATFORM_ID, namespace: CONNECTION_NS, payload: JSON.stringify({ type: "CONNECT" }) });
    this.pinger = setInterval(() => {
      if (Date.now() - this.lastHeard > SILENCE_MS) return this.close();
      this.send({ sourceId: SENDER_ID, destinationId: PLATFORM_ID, namespace: HEARTBEAT_NS, payload: JSON.stringify({ type: "PING" }) });
    }, PING_MS);
    this.pinger.unref?.();
  }

  /** Connects to a device, rejecting when it can't be reached in time. */
  public static open(host: string, port: number): Promise<CastChannel> {
    return new Promise((resolve, reject) => {
      const socket = connect({ host, port, rejectUnauthorized: false, timeout: CONNECT_TIMEOUT_MS });

      // Settle once: connected, or failed first
      const fail = (error: Error) => {
        socket.destroy();
        reject(error);
      };
      socket.once("secureConnect", () => {
        socket.off("error", fail);
        socket.setTimeout(0);
        resolve(new CastChannel(socket));
      });
      socket.once("error", fail);
      socket.once("timeout", () => fail(new Error(`${host}:${port} didn't answer`)));
    });
  }

  public get closed(): boolean {
    return this.ended;
  }

  public send(frame: CastFrame): void {
    if (this.ended) return;
    this.socket.write(CastMessage.encode(frame));
  }

  public close(): void {
    if (this.ended) return;
    this.socket.end();
    this.socket.destroy();
    this.finish();
  }

  // ---------- Inner workings ---------- //

  /** Collects bytes and hands on every complete message. */
  private receive(chunk: Buffer): void {
    this.lastHeard = Date.now();
    this.buffer = Buffer.concat([this.buffer, chunk]);

    while (this.buffer.length >= 4) {
      // A frame longer than Cast allows means the stream is out of step
      const length = this.buffer.readUInt32BE(0);
      if (length > MAX_FRAME_BYTES) return this.close();
      if (this.buffer.length < 4 + length) return;
      const body = this.buffer.subarray(4, 4 + length);
      this.buffer = this.buffer.subarray(4 + length);

      let frame: CastFrame | null;
      try {
        frame = CastMessage.decode(body);
      } catch {
        return this.close();
      }
      if (!frame) continue;

      // Pings are answered here; everything else goes to the user
      if (frame.namespace === HEARTBEAT_NS) {
        if (frame.payload.includes('"PING"')) this.send({ sourceId: SENDER_ID, destinationId: frame.sourceId, namespace: HEARTBEAT_NS, payload: JSON.stringify({ type: "PONG" }) });
        continue;
      }
      this.onMessage?.(frame);
    }
  }

  /** Marks the channel closed and tells the user, once. */
  private finish(): void {
    if (this.ended) return;
    this.ended = true;
    clearInterval(this.pinger);
    this.onClose?.();
  }
}
