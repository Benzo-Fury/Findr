/**
 * A network Findr finds and drives DLNA renderers on. The server's own
 * network is one; each connected cast bridge is another, standing in for
 * the server on a network it can't reach. The controller does the same work
 * on every network, through these three operations.
 */

/** One HTTP request to a renderer: reading its description or calling an action. */
export interface HttpExchange {
  url: string;
  method: "GET" | "POST";
  headers: Record<string, string>;
  body: string | null;
  /** How long to wait for an answer. */
  timeoutMs: number;
}

/** A renderer's answer to an `HttpExchange`. */
export interface HttpReply {
  status: number;
  body: string;
}

export interface RendererNetwork {
  /** `local` for the server's own network, else the bridge's id. */
  readonly id: string;
  /** Where its TVs are, shown beside their names; null for the server's own network. */
  readonly place: string | null;
  /** Whether its TVs are on the server's network, so the remote bitrate cap doesn't apply. */
  readonly local: boolean;
  /** Whether it can be searched and driven right now. */
  readonly connected: boolean;

  /** Searches for renderers and resolves with their description URLs. Never rejects. */
  search(): Promise<Set<string>>;

  /**
   * Sends one request to a renderer, following no redirects. Throws when the
   * renderer doesn't answer in time or can't be reached.
   */
  request(exchange: HttpExchange): Promise<HttpReply>;

  /** The base URL renderers on it fetch media from, or null when there is none. */
  mediaBase(): string | null;
}
