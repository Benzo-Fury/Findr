/**
 * Findr run as a cast bridge (`findr bridge`): on a network the server can't
 * reach, it finds the DLNA TVs there and drives them for the server. It holds
 * one WebSocket open to the server, reconnecting whenever it drops, and runs
 * the media proxy TVs fetch from.
 *
 * The server can only ask for what driving a TV needs: a search, and HTTP
 * requests to devices the bridge itself found answering one. Anything else on
 * the bridge's network stays out of the server's reach. It needs no database
 * and reads no settings; everything comes from its command line or environment.
 */

import { parseArgs } from "node:util";
import { version as packageVersion } from "../../../../../../package.json";
import { LanInterface } from "../LanInterface";
import { LanHttp } from "../dlna/LanHttp";
import type { HttpExchange } from "../dlna/RendererNetwork";
import { Ssdp } from "../dlna/Ssdp";
import { BRIDGE_CONNECT_PATH, BRIDGE_PROTOCOL, MAX_BODY_BYTES, type ServerMessage, ServerMessageSchema } from "./BridgeProtocol";
import { BridgeMediaProxy } from "./BridgeMediaProxy";

// ---------- Options ---------- //

/** How a bridge is told where the server is and how to serve its TVs. */
export interface BridgeOptions {
  /** The server's origin, as the browser opens it. */
  server: string;
  token: string;
  /** The media proxy's port. */
  port: number;
  /** The base URL TVs fetch from, when the bridge's own address on the network isn't it. */
  mediaUrl: string | null;
}

/** A command line or environment the bridge can't run with. */
export class BridgeUsageError extends Error {}

/** The media proxy's port unless told otherwise. */
const DEFAULT_PORT = 34572;

const USAGE = `Usage: findr bridge --server <url> --token <token> [--port <port>] [--media-url <url>]

Finds DLNA TVs on this network and drives them for a Findr server elsewhere.
Add the bridge under Settings → Playback on the server to get its token.

  --server     The server's address, such as https://findr.example.com (FINDR_SERVER)
  --token      The bridge's token (FINDR_BRIDGE_TOKEN)
  --port       Port TVs fetch video from; default ${DEFAULT_PORT} (FINDR_BRIDGE_PORT)
  --media-url  Address TVs fetch from, when not this machine's own (FINDR_BRIDGE_MEDIA_URL)`;

// ---------- Timing ---------- //

/** How often the bridge pings the server, keeping proxies in between from idling the connection out. */
const PING_MS = 25_000;

/** Reconnect delays: doubling from the first to the last. */
const RETRY_MIN_MS = 1000;
const RETRY_MAX_MS = 30_000;

/**
 * Devices that answered a search are reachable for this long after their
 * last answer to a search or a request, matching how long the server keeps
 * them and letting a TV being driven outlast it, as the server's does.
 */
const DEVICE_TTL_MS = 10 * 60_000;

/** Headers a TV request may carry; anything else the server sends is dropped. */
const ALLOWED_HEADERS = new Set(["content-type", "soapaction"]);

/**
 * Bun's WebSocket, whose constructor also takes headers. The DOM's typing of
 * `WebSocket`, which wins in this project, only knows subprotocols.
 */
const BunWebSocket = WebSocket as unknown as new (url: string, options: Bun.WebSocketOptions) => WebSocket;

// ---------- Agent ---------- //

export class BridgeAgent {
  private readonly proxy: BridgeMediaProxy;
  /** Hosts that answered a search, with when they last did. Only these may be sent requests. */
  private readonly devices = new Map<string, number>();
  private socket: WebSocket | null = null;
  private pinger: ReturnType<typeof setInterval> | null = null;
  private retryMs = RETRY_MIN_MS;
  private stopped = false;

  private readonly discover: () => Promise<Set<string>>;
  private readonly onFatal: (reason: string) => void;

  /**
   * A bridge with `options`. Tests replace how it finds devices (an SSDP
   * search) and what it does when it can't go on (log and exit).
   */
  constructor(
    private readonly options: BridgeOptions,
    hooks: { discover?: () => Promise<Set<string>>; onFatal?: (reason: string) => void } = {},
  ) {
    this.proxy = new BridgeMediaProxy(options.server, options.port);
    this.discover = hooks.discover ?? (() => Ssdp.search(LanInterface.address()));
    this.onFatal =
      hooks.onFatal ??
      ((reason) => {
        console.error(`[Bridge] ${reason}`);
        process.exit(1);
      });
  }

  /** Runs a bridge from the command line until the process is stopped. */
  public static async run(args: string[]): Promise<void> {
    let options: BridgeOptions;
    try {
      options = BridgeAgent.parse(args, process.env);
    } catch (error) {
      // Asked for help: usage, and no failure; anything else: what is wrong, then usage
      if (error instanceof BridgeUsageError) {
        if (!error.message) {
          console.log(USAGE);
          process.exit(0);
        }
        console.error(`${error.message}\n\n${USAGE}`);
        process.exit(2);
      }
      throw error;
    }

    const agent = new BridgeAgent(options);
    agent.start();
    for (const signal of ["SIGINT", "SIGTERM"] as const) {
      process.on(signal, () => void agent.stop().then(() => process.exit(0)));
    }
  }

  /** Reads options from the command line, falling back to the environment. */
  public static parse(args: string[], env: Record<string, string | undefined>): BridgeOptions {
    let values;
    try {
      ({ values } = parseArgs({
        args,
        options: { server: { type: "string" }, token: { type: "string" }, port: { type: "string" }, "media-url": { type: "string" }, help: { type: "boolean", short: "h" } },
      }));
    } catch (error) {
      throw new BridgeUsageError(error instanceof Error ? error.message : String(error));
    }
    if (values.help) throw new BridgeUsageError("");

    // The server, as an origin
    const server = values.server ?? env.FINDR_SERVER ?? "";
    let origin: string;
    try {
      const url = new URL(server);
      if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error();
      origin = url.origin;
    } catch {
      throw new BridgeUsageError(server ? `--server must be an http:// or https:// address, not "${server}"` : "--server is required");
    }

    const token = values.token ?? env.FINDR_BRIDGE_TOKEN ?? "";
    if (!token) throw new BridgeUsageError("--token is required");

    const portText = values.port ?? env.FINDR_BRIDGE_PORT ?? String(DEFAULT_PORT);
    const port = Number(portText);
    if (!Number.isInteger(port) || port < 1 || port > 65_535) throw new BridgeUsageError(`--port must be a port number, not "${portText}"`);

    // An address TVs reach the proxy at, with no path
    const mediaText = values["media-url"] ?? env.FINDR_BRIDGE_MEDIA_URL ?? "";
    const mediaUrl = mediaText ? mediaText.replace(/\/+$/, "") : null;
    if (mediaUrl && !/^https?:\/\/[^\s/]+$/.test(mediaUrl)) throw new BridgeUsageError(`--media-url must be an address such as http://192.168.1.30:${DEFAULT_PORT}, not "${mediaText}"`);

    return { server: origin, token, port, mediaUrl };
  }

  // ---------- Lifecycle ---------- //

  /** Starts the media proxy and connects to the server. */
  public start(): void {
    this.proxy.start();
    console.log(`[Bridge] Findr ${BridgeAgent.version} bridging TVs on this network to ${this.options.server}`);
    console.log(`[Bridge] TVs will fetch video from ${this.mediaBase() ?? "an unknown address (set --media-url)"}`);
    this.connect();
  }

  /** Disconnects and stops the media proxy. */
  public async stop(): Promise<void> {
    this.stopped = true;
    if (this.pinger) clearInterval(this.pinger);
    this.socket?.close(1000, "bridge stopping");
    await this.proxy.stop();
  }

  /** The base URL TVs fetch media from: `--media-url`, else this machine's address on the network. */
  public mediaBase(): string | null {
    if (this.options.mediaUrl) return this.options.mediaUrl;
    const address = LanInterface.address();
    const port = this.proxy.boundPort ?? this.options.port;
    return address ? `http://${address}:${port}` : null;
  }

  /** The Findr version this bridge runs. */
  private static get version(): string {
    return process.env.FINDR_VERSION ?? packageVersion;
  }

  // ---------- Connection ---------- //

  /** Opens the WebSocket to the server and says hello once it is up. */
  private connect(): void {
    if (this.stopped) return;
    const url = `${this.options.server.replace(/^http/, "ws")}${BRIDGE_CONNECT_PATH}`;
    const socket = new BunWebSocket(url, { headers: { Authorization: `Bearer ${this.options.token}` } });
    this.socket = socket;
    let opened = false;

    socket.addEventListener("open", () => {
      opened = true;
      this.retryMs = RETRY_MIN_MS;
      const mediaBase = this.mediaBase();
      if (!mediaBase) console.warn("[Bridge] This machine has no address on the local network; set --media-url so TVs can reach the bridge");
      socket.send(JSON.stringify({ type: "hello", protocol: BRIDGE_PROTOCOL, version: BridgeAgent.version, mediaBase }));
      console.log("[Bridge] Connected to the server");

      // Ping now and then so nothing in between closes a quiet connection
      if (this.pinger) clearInterval(this.pinger);
      this.pinger = setInterval(() => {
        if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type: "ping" }));
      }, PING_MS);
    });

    socket.addEventListener("message", (event) => {
      if (typeof event.data === "string") void this.answer(socket, event.data);
    });

    socket.addEventListener("close", (event) => {
      if (this.socket !== socket) return;
      this.socket = null;
      if (this.pinger) clearInterval(this.pinger);
      this.pinger = null;
      if (this.stopped) return;

      // Removed or replaced on the server: say so; anything else is retried
      if (event.code === 4001) return this.fail("The server removed this bridge. Add it again under Settings → Playback and use the new token.");
      if (event.code === 4002) return this.fail(`The server runs a different version of Findr than this bridge (${BridgeAgent.version}). Update both to the same version.`);
      if (opened) console.warn(`[Bridge] Disconnected from the server${event.reason ? ` (${event.reason})` : ""}; reconnecting`);
      void (opened ? Promise.resolve() : this.explainRefusal()).then(() => this.retry());
    });
  }

  /** Connects again after a delay that grows while the server stays away. */
  private retry(): void {
    if (this.stopped) return;
    const delay = this.retryMs;
    this.retryMs = Math.min(this.retryMs * 2, RETRY_MAX_MS);
    setTimeout(() => this.connect(), delay).unref?.();
  }

  /**
   * Works out why the server wouldn't take the connection, since a refused
   * WebSocket doesn't say: asks the same address over plain HTTP. A refusal
   * that won't go away by itself stops the bridge.
   */
  private async explainRefusal(): Promise<void> {
    let status: number;
    let code = "";
    try {
      const response = await fetch(`${this.options.server}${BRIDGE_CONNECT_PATH}`, {
        headers: { Authorization: `Bearer ${this.options.token}` },
        signal: AbortSignal.timeout(10_000),
      });
      status = response.status;
      code = ((await response.json().catch(() => null)) as { error?: string } | null)?.error ?? "";
    } catch (error) {
      console.warn(`[Bridge] Can't reach ${this.options.server}: ${error instanceof Error ? error.message : String(error)}; retrying`);
      return;
    }

    // The token or the server's settings are wrong, which waiting won't fix
    if (code === "bridge_unknown") return this.fail("The server doesn't know this token. Add the bridge under Settings → Playback and use the token it shows.");
    if (code === "remote_access_disabled") return this.fail("The server turns away other machines. Turn on remote access under Settings → Access.");

    // Things an admin may switch back on
    if (code === "playback_disabled" || code === "casting_disabled") console.warn(`[Bridge] ${code === "playback_disabled" ? "Playback" : "Casting"} is off on the server; waiting for it to be turned on`);
    else console.warn(`[Bridge] The server refused the connection (HTTP ${status}${code ? `, ${code}` : ""}); retrying`);
  }

  /** Stops the bridge for good, saying why. */
  private fail(reason: string): void {
    void this.stop().then(() => this.onFatal(reason));
  }

  // ---------- Answering the server ---------- //

  /** Carries out one of the server's questions and sends back the reply. */
  private async answer(socket: WebSocket, data: string): Promise<void> {
    let message: ServerMessage;
    try {
      message = ServerMessageSchema.parse(JSON.parse(data));
    } catch {
      console.warn("[Bridge] The server sent something unreadable; ignoring it");
      return;
    }

    let reply: object;
    try {
      const result = message.type === "search" ? [...(await this.search())] : await this.send(message.exchange);
      reply = { type: "reply", id: message.id, ok: true, result };
    } catch (error) {
      reply = { type: "reply", id: message.id, ok: false, error: (error instanceof Error ? error.message : String(error)).slice(0, 500) };
    }
    if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(reply));
  }

  /** Searches the network, remembering which hosts answered so the server may reach them. */
  public async search(): Promise<Set<string>> {
    const locations = await this.discover();
    const now = Date.now();
    for (const location of locations) this.devices.set(new URL(location).hostname, now);
    for (const [host, seen] of this.devices) if (now - seen > DEVICE_TTL_MS) this.devices.delete(host);
    return locations;
  }

  /**
   * Sends a request to a TV for the server. Refused unless it goes over HTTP
   * to a device that answered a search, carrying only the headers driving a
   * TV needs.
   */
  public async send(exchange: HttpExchange): Promise<{ status: number; body: string }> {
    let url: URL;
    try {
      url = new URL(exchange.url);
    } catch {
      throw new Error("not a URL");
    }
    const seen = this.devices.get(url.hostname);
    if ((url.protocol !== "http:" && url.protocol !== "https:") || seen === undefined || Date.now() - seen > DEVICE_TTL_MS) {
      throw new Error(`${url.hostname} isn't a device this bridge found`);
    }

    // Only the headers SOAP needs
    const headers: Record<string, string> = {};
    for (const [name, value] of Object.entries(exchange.headers)) {
      if (ALLOWED_HEADERS.has(name.toLowerCase())) headers[name] = value;
    }

    // A device that answers is still there, so a TV being driven stays reachable between searches
    const reply = await LanHttp.request({ ...exchange, url: url.toString(), headers });
    this.devices.set(url.hostname, Date.now());
    return { status: reply.status, body: reply.body.slice(0, MAX_BODY_BYTES) };
  }
}
