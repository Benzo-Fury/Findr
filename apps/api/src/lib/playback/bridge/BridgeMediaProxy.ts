/**
 * The cast bridge's media proxy. TVs on the bridge's network are handed URLs
 * on it, plain HTTP on a local address as TVs handle best, and it fetches
 * each request from the server, passing byte ranges and DLNA's headers both
 * ways. It answers only machines on its local network, and only for the two
 * things a TV is ever sent: a stream under its signed token, and the splash.
 */

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
  private listener: ReturnType<typeof Bun.serve> | null = null;

  /** A proxy to `server`, an origin such as `https://findr.example.com`, on `port` (0 picks a free one). */
  constructor(
    private readonly server: string,
    private readonly port: number,
  ) {}

  /** Starts listening on every interface, so TVs on the network can reach it. */
  public start(): void {
    this.listener = Bun.serve({
      port: this.port,
      hostname: "0.0.0.0",
      idleTimeout: IDLE_TIMEOUT_SECONDS,
      fetch: (request, server) => this.handle(request, server.requestIP(request)?.address ?? null),
    });
  }

  /** The port it listens on, once started. */
  public get boundPort(): number | null {
    return this.listener?.port ?? null;
  }

  public async stop(): Promise<void> {
    await this.listener?.stop(true);
    this.listener = null;
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
