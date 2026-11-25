/**
 * The pieces every network shares for Google Cast devices: what a search
 * finds, and the connection a receiver is driven over. On the server's own
 * network a link is a `CastChannel`, the TLS connection itself; on a cast
 * bridge's it is relayed over the bridge's WebSocket to a channel the bridge
 * holds.
 */

import type { CastFrame } from "./CastMessage";

/** A Google Cast device an mDNS search found. */
export interface CastDevice {
  /** Its own id, from its mDNS record; the same on every search. */
  id: string;
  /** The name its owner gave it, such as `Living room TV`. */
  name: string;
  /** Its model, such as `Chromecast` or `Google TV Streamer`, when it says. */
  model: string | null;
  /** Its IPv4 address, the one the answer came from. */
  host: string;
  /** Its Cast port, almost always 8009. */
  port: number;
}

/**
 * A connection to one Cast device. Messages arrive through `onMessage` until
 * it closes, after which `onClose` is called once and nothing more is sent.
 * Heartbeats are answered by whoever holds the socket, so a link stays up
 * with no traffic from its user.
 */
export interface CastLink {
  /** Whether it has closed; a closed link is never reopened. */
  readonly closed: boolean;
  /** Called with every JSON message the device sends. */
  onMessage: ((frame: CastFrame) => void) | null;
  /** Called once when the connection ends, from either side. */
  onClose: (() => void) | null;
  /** Sends a message; dropped once closed. */
  send(frame: CastFrame): void;
  /** Ends the connection. */
  close(): void;
}
