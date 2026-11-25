/**
 * The cast bridge's media proxy. TVs on the bridge's network are handed URLs
 * on it, plain HTTP on a local address as TVs handle best, and it fetches
 * each request from the server, passing byte ranges and DLNA's headers both
 * ways. It answers only machines on its local network, and only for the two
 * things a TV is ever sent: a stream under its signed token, and the splash.
 *
 * It listens with `node:http` rather than `Bun.serve`: Bun drops the
 * server's Content-Length from a streamed body and sends it chunked, and
 * many TVs refuse a file of unknown length ("File not supported").
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { LocalNetwork } from "../LocalNetwork";

/** The paths a TV fetches: `/api/playback/stream/<token>/<file>` and the splash. */
const MEDIA_PATH = /^\/api\/playback\/(stream\/[^/]+\/[^/]+|splash)$/;

/** Headers that belong to one connection, never passed on. */
const HOP_BY_HOP = new Set(["connection", "keep-alive", "proxy-authenticate", "proxy-authorization", "te", "trailer", "transfer-encoding", "upgrade", "host", "content-encoding"]);

/** Headers a TV must not get to send the server under the bridge's name. */
const PRIVATE_HEADERS = new Set(["cookie", "authorization", "x-forwarded-for", "x-real-ip", "forwarded"]);

/**
 * Seconds a connection may sit with nothing sent. A paused TV stops reading;
 * when it is let go, the TV asks again with a range.
 */
const IDLE_TIMEOUT_SECONDS = 120;

export class BridgeMediaProxy {
  private listener: Server | null = null;

  /** A proxy to `server`, an origin such as `https://findr.example.com`, on `port` (0 picks a free one). */
  constructor(
    private readonly server: string,
    private readonly port: number,
  ) {}

  /** Starts listening on every interface, so TVs on the network can reach it. */
  public start(): void {
    this.listener = createServer((incoming, outgoing) => void this.serve(incoming, outgoing));
    this.listener.setTimeout(IDLE_TIMEOUT_SECONDS * 1000);
    this.listener.listen(this.port, "0.0.0.0");
  }

  /** The port it listens on, once started. */
  public get boundPort(): number | null {
    const address = this.listener?.address();
    return address && typeof address === "object" ? (address as AddressInfo).port : null;
  }

  public async stop(): Promise<void> {
    const listener = this.listener;
    this.listener = null;
    if (!listener) return;
    listener.closeAllConnections();
    await new Promise<void>((resolve) => listener.close(() => resolve()));
  }

  /**
   * Answers one connection's request through `handle`, writing the answer's
   * headers as they are, Content-Length included, and streaming its body.
   */
  private async serve(incoming: IncomingMessage, outgoing: ServerResponse): Promise<void> {
    // The TV hanging up cancels the fetch from the server
    const aborter = new AbortController();
    outgoing.on("close", () => aborter.abort());

    // Only the path and query are used, so the TV's Host header is never trusted
    const headers = new Headers();
    for (const [name, value] of Object.entries(incoming.headers)) {
      if (value !== undefined) headers.set(name, Array.isArray(value) ? value.join(", ") : value);
    }
    let request: Request;
    try {
      request = new Request(new URL(incoming.url ?? "/", "http://bridge"), { method: incoming.method, headers, signal: aborter.signal });
    } catch {
      outgoing.writeHead(400).end();
      return;
    }

    // Write the answer back, its body as it streams in
    const response = await this.handle(request, incoming.socket.remoteAddress ?? null);
    const answer: Record<string, string> = {};
    for (const [name, value] of response.headers) answer[name] = value;
    outgoing.writeHead(response.status, answer);
    if (!response.body) {
      outgoing.end();
      return;
    }
    try {
      await pipeline(Readable.from(response.body), outgoing);
    } catch {
      // The TV hung up or the server's stream broke; the connection is already gone
    }
  }

  /** Answers one request from a TV, by passing it on to the server. */
  public async handle(request: Request, address: string | null): Promise<Response> {
    // Local machines only, media only
    if (!address || !LocalNetwork.isPrivate(address)) return new Response("Forbidden", { status: 403 });
    if (request.method !== "GET" && request.method !== "HEAD") return new Response("Method not allowed", { status: 405, headers: { allow: "GET, HEAD" } });
    const url = new URL(request.url);
    if (!MEDIA_PATH.test(url.pathname)) return new Response("Not found", { status: 404 });

    // Pass the TV's own headers (ranges, DLNA's) on, uncompressed so ranges stay byte-exact
    const headers = new Headers();
    for (const [name, value] of request.headers) {
      if (!HOP_BY_HOP.has(name) && !PRIVATE_HEADERS.has(name)) headers.set(name, value);
    }
    headers.set("accept-encoding", "identity");

    let upstream: Response;
    try {
      upstream = await fetch(`${this.server}${url.pathname}${url.search}`, { method: request.method, headers, redirect: "manual", signal: request.signal });
    } catch (error) {
      console.warn(`[Bridge] Couldn't fetch ${url.pathname.replace(/stream\/[^/]+/, "stream/…")} from the server: ${error instanceof Error ? error.message : String(error)}`);
      return new Response("Bad gateway", { status: 502 });
    }

    // Hand the answer back as it streams in
    const answer = new Headers();
    for (const [name, value] of upstream.headers) {
      if (!HOP_BY_HOP.has(name) && name !== "set-cookie") answer.set(name, value);
    }
    return new Response(request.method === "HEAD" ? null : upstream.body, { status: upstream.status, headers: answer });
  }
}
