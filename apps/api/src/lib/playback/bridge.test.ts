import { afterAll, afterEach, beforeAll, describe, expect, setSystemTime, spyOn, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PlaybackItemKey } from "@findr/types/playback";
import { migrateAuth } from "../auth/client";
import { database } from "../db/client";
import { CastBridge } from "../db/models/CastBridge";
import { MediaItem } from "../db/models/MediaItem";
import { SettingsStore } from "../db/models/SettingsStore";
import { Title } from "../db/models/Title";
import { Server } from "../server/Server";
import { BridgeAgent, BridgeUsageError } from "./bridge/BridgeAgent";
import BridgeHub from "./bridge/BridgeHub";
import { BridgeMediaProxy } from "./bridge/BridgeMediaProxy";
import { CastAddress } from "./CastAddress";
import DlnaController from "./dlna/DlnaController";
import { LocalRendererNetwork } from "./dlna/LocalRendererNetwork";
import type { ProbeInfo } from "./MediaProbe";
import PlaybackService from "./PlaybackService";

beforeAll(async () => {
  await migrateAuth();
});

/** A free port, found by binding one and letting it go. */
function freePort(): number {
  const probe = Bun.serve({ port: 0, fetch: () => new Response() });
  const port = probe.port ?? 0;
  probe.stop(true);
  return port;
}

/** Waits until a check passes, failing after `timeoutMs`. */
async function until(check: () => boolean, timeoutMs = 10_000): Promise<void> {
  const deadline = performance.now() + timeoutMs;
  while (!check()) {
    if (performance.now() > deadline) throw new Error("timed out waiting");
    await Bun.sleep(50);
  }
}

// ---------- Addresses for TVs ---------- //

describe("CastAddress", () => {
  afterEach(() => SettingsStore.update({ playback: { castBaseUrl: "" } }));

  test("a client on the server's network gets the address for TVs there", () => {
    SettingsStore.update({ playback: { castBaseUrl: "http://192.168.1.20:34571/" } });
    expect(CastAddress.forClient(true)).toBe("http://192.168.1.20:34571");
  });

  test("a client elsewhere never gets a local address, only a public one", () => {
    // No public URL is set in tests, so only a public address for TVs will do
    for (const local of ["http://192.168.1.20:34571", "http://localhost:34571", "http://nas.local:34571", "http://[fd00::4]:34571"]) {
      SettingsStore.update({ playback: { castBaseUrl: local } });
      expect(CastAddress.forClient(false)).toBeNull();
    }
    SettingsStore.update({ playback: { castBaseUrl: "https://tv.example.com" } });
    expect(CastAddress.forClient(false)).toBe("https://tv.example.com");
  });
});

// ---------- Tokens and options ---------- //

describe("CastBridge", () => {
  test("knows a bridge by its token, and stops when it is removed", () => {
    const { bridge, token } = CastBridge.create("Holiday house");
    expect(token).toStartWith("fcb_");
    expect(CastBridge.findByToken(token)?.id).toBe(bridge.id);
    expect(CastBridge.findByToken(`${token}x`)).toBeNull();
    expect(CastBridge.findByToken("not a token")).toBeNull();

    // Only a hash is stored
    const stored = database.query<{ token_hash: string }, [string]>("SELECT token_hash FROM cast_bridges WHERE id = ?").get(bridge.id);
    expect(stored?.token_hash).not.toContain(token.slice(4));

    bridge.delete();
    expect(CastBridge.findByToken(token)).toBeNull();
  });
});

describe("BridgeAgent options", () => {
  test("reads the command line, falling back to the environment", () => {
    expect(BridgeAgent.parse(["--server", "https://findr.example.com/settings", "--token", "fcb_abc"], {})).toEqual({
      server: "https://findr.example.com",
      token: "fcb_abc",
      port: 34572,
      mediaUrl: null,
    });
    expect(BridgeAgent.parse([], { FINDR_SERVER: "http://10.0.0.2:34571", FINDR_BRIDGE_TOKEN: "fcb_x", FINDR_BRIDGE_PORT: "9000", FINDR_BRIDGE_MEDIA_URL: "http://192.168.4.4:9000/" })).toEqual({
      server: "http://10.0.0.2:34571",
      token: "fcb_x",
      port: 9000,
      mediaUrl: "http://192.168.4.4:9000",
    });
  });

  test("refuses what it can't run with", () => {
    expect(() => BridgeAgent.parse(["--token", "fcb_x"], {})).toThrow("--server is required");
    expect(() => BridgeAgent.parse(["--server", "ftp://x", "--token", "t"], {})).toThrow(BridgeUsageError);
    expect(() => BridgeAgent.parse(["--server", "https://x"], {})).toThrow("--token is required");
    expect(() => BridgeAgent.parse(["--server", "https://x", "--token", "t", "--port", "70000"], {})).toThrow("--port");
    expect(() => BridgeAgent.parse(["--server", "https://x", "--token", "t", "--media-url", "http://x/path"], {})).toThrow("--media-url");
    expect(() => BridgeAgent.parse(["--nonsense"], {})).toThrow(BridgeUsageError);
  });
});

// ---------- What the server may reach through a bridge ---------- //

describe("BridgeAgent requests", () => {
  let device: ReturnType<typeof Bun.serve>;
  let seenHeaders: Headers | null = null;

  beforeAll(() => {
    device = Bun.serve({
      port: 0,
      fetch(request) {
        seenHeaders = request.headers;
        return new Response("<ok/>");
      },
    });
  });
  afterAll(() => device.stop(true));

  test("only reaches devices that answered its own search, with only SOAP's headers", async () => {
    const location = `http://127.0.0.1:${device.port}/description.xml`;
    const agent = new BridgeAgent({ server: "http://127.0.0.1:1", token: "t", port: 0, mediaUrl: null }, { discover: async () => new Set([location]) });
    const exchange = { url: location, method: "GET" as const, headers: { SOAPACTION: '"x#Play"', Cookie: "session=1", Host: "elsewhere" }, body: null, timeoutMs: 2000 };

    // Before any search, nothing is reachable
    await expect(agent.send(exchange)).rejects.toThrow("isn't a device this bridge found");

    // After it, the device is, but nothing else on the network and no other scheme
    expect([...(await agent.search())]).toEqual([location]);
    expect(await agent.send(exchange)).toEqual({ status: 200, body: "<ok/>" });
    expect(seenHeaders?.get("soapaction")).toBe('"x#Play"');
    expect(seenHeaders?.get("cookie")).toBeNull();
    await expect(agent.send({ ...exchange, url: "http://10.20.30.40/admin" })).rejects.toThrow("isn't a device");
    await expect(agent.send({ ...exchange, url: `file://127.0.0.1/etc/passwd` })).rejects.toThrow("isn't a device");
  });

  test("keeps a device it is driving past its last search, and forgets one left alone", async () => {
    const location = `http://127.0.0.1:${device.port}/description.xml`;
    const agent = new BridgeAgent({ server: "http://127.0.0.1:1", token: "t", port: 0, mediaUrl: null }, { discover: async () => new Set([location]) });
    const exchange = { url: location, method: "GET" as const, headers: {}, body: null, timeoutMs: 2000 };
    const start = Date.now();
    try {
      await agent.search();

      // Polled every few minutes, as a TV playing a film is, it stays reachable long after the search
      for (let minutes = 4; minutes <= 20; minutes += 4) {
        setSystemTime(start + minutes * 60_000);
        expect((await agent.send(exchange)).status).toBe(200);
      }

      // Left alone past the limit, it is forgotten
      setSystemTime(start + 31 * 60_000);
      await expect(agent.send(exchange)).rejects.toThrow("isn't a device this bridge found");
    } finally {
      setSystemTime();
    }
  });
});

describe("BridgeMediaProxy", () => {
  let upstream: ReturnType<typeof Bun.serve>;
  let proxy: BridgeMediaProxy;
  let asked: { path: string; headers: Record<string, string> } | null = null;

  beforeAll(() => {
    upstream = Bun.serve({
      port: 0,
      fetch(request) {
        asked = { path: new URL(request.url).pathname, headers: Object.fromEntries(request.headers) };
        return new Response("ABCD", { status: 206, headers: { "content-range": "bytes 0-3/100", "contentFeatures.dlna.org": "DLNA.ORG_OP=01", "set-cookie": "a=b" } });
      },
    });
    proxy = new BridgeMediaProxy(`http://127.0.0.1:${upstream.port}`, 0);
  });
  afterAll(() => upstream.stop(true));

  const at = (path: string, init?: RequestInit) => new Request(`http://192.168.1.30:34572${path}`, init);

  test("passes a TV's ranged request for media on, and the answer back", async () => {
    const response = await proxy.handle(at("/api/playback/stream/tok.en.sig/media.mkv", { headers: { range: "bytes=0-3", "getcontentFeatures.dlna.org": "1", cookie: "x=y" } }), "192.168.1.50");
    expect(response.status).toBe(206);
    expect(await response.text()).toBe("ABCD");
    expect(response.headers.get("content-range")).toBe("bytes 0-3/100");
    expect(response.headers.get("contentfeatures.dlna.org")).toBe("DLNA.ORG_OP=01");
    expect(response.headers.get("set-cookie")).toBeNull();
    expect(asked).toMatchObject({ path: "/api/playback/stream/tok.en.sig/media.mkv", headers: { range: "bytes=0-3", "accept-encoding": "identity" } });
    expect(asked?.headers.cookie).toBeUndefined();
  });

  test("answers only machines on its network, and only for media", async () => {
    expect((await proxy.handle(at("/api/playback/splash"), "192.168.1.50")).status).toBe(206);
    expect((await proxy.handle(at("/api/playback/splash"), "203.0.113.9")).status).toBe(403);
    expect((await proxy.handle(at("/api/playback/splash"), null)).status).toBe(403);
    expect((await proxy.handle(at("/api/settings"), "192.168.1.50")).status).toBe(404);
    expect((await proxy.handle(at("/api/playback/stream/tok/media.mkv/extra"), "192.168.1.50")).status).toBe(404);
    expect((await proxy.handle(at("/api/playback/splash", { method: "POST" }), "192.168.1.50")).status).toBe(405);
  });

  test("keeps the server's Content-Length on a streamed body, as many TVs need", async () => {
    // A body big enough that it streams rather than arriving in one piece
    const size = 4_000_000;
    const big = Bun.serve({
      port: 0,
      fetch(request) {
        if (request.headers.get("range")) return new Response(new Uint8Array(1000), { status: 206, headers: { "content-range": `bytes 0-999/${size}` } });
        return new Response(new Uint8Array(size), { headers: { "content-type": "video/x-matroska" } });
      },
    });
    const listening = new BridgeMediaProxy(`http://127.0.0.1:${big.port}`, 0);
    listening.start();
    try {
      await until(() => listening.boundPort !== null);
      const url = `http://127.0.0.1:${listening.boundPort}/api/playback/stream/tok.en.sig/media.mkv`;

      const whole = await fetch(url);
      expect(whole.headers.get("content-length")).toBe(String(size));
      expect(whole.headers.get("transfer-encoding")).toBeNull();
      expect((await whole.arrayBuffer()).byteLength).toBe(size);

      const head = await fetch(url, { method: "HEAD" });
      expect(head.headers.get("content-length")).toBe(String(size));

      const part = await fetch(url, { headers: { range: "bytes=0-999" } });
      expect(part.status).toBe(206);
      expect(part.headers.get("content-length")).toBe("1000");
      expect((await part.arrayBuffer()).byteLength).toBe(1000);
    } finally {
      await listening.stop();
      big.stop(true);
    }
  });
});

// ---------- From the server to a TV on the bridge's network ---------- //

const hasFfmpeg = Bun.which("ffmpeg") !== null && Bun.which("ffprobe") !== null;

describe.skipIf(!hasFfmpeg)("Casting through a bridge", () => {
  const viewer = "bridge-viewer";
  const server = new Server();
  let tv: ReturnType<typeof Bun.serve>;
  let actions: Array<{ action: string; body: string }> = [];
  let root: string;
  let movie: PlaybackItemKey;
  let agent: BridgeAgent;
  let bridge: CastBridge;
  let mediaUrl: string;
  const fatal: string[] = [];
  const bytes = Uint8Array.from({ length: 4096 }, (_, index) => index % 251);

  beforeAll(async () => {
    const now = new Date().toISOString();
    database.query("INSERT INTO user (id, name, email, emailVerified, createdAt, updatedAt) VALUES (?, ?, ?, 0, ?, ?)").run(viewer, viewer, `${viewer}@findr.local`, now, now);
    SettingsStore.update({ playback: { enabled: true, casting: true, trickplay: false } });
    await PlaybackService.getInstance().start();
    await server.constructRoutes();
    server.start(0);

    // Searching the server's own network would find real TVs; it finds none here
    spyOn(LocalRendererNetwork.instance, "search").mockResolvedValue(new Set());

    // A TV on the bridge's network that takes Matroska as it is
    tv = Bun.serve({
      port: 0,
      async fetch(request) {
        if (new URL(request.url).pathname === "/description.xml") {
          return new Response(`<?xml version="1.0"?>
<root><device><deviceType>urn:schemas-upnp-org:device:MediaRenderer:1</deviceType><friendlyName>Den TV</friendlyName><UDN>uuid:den-tv</UDN><serviceList>
  <service><serviceType>urn:schemas-upnp-org:service:AVTransport:1</serviceType><controlURL>/av</controlURL></service>
  <service><serviceType>urn:schemas-upnp-org:service:ConnectionManager:1</serviceType><controlURL>/cm</controlURL></service>
</serviceList></device></root>`);
        }
        const action = /#(\w+)"/.exec(request.headers.get("soapaction") ?? "")?.[1] ?? "";
        actions.push({ action, body: await request.text() });
        const fields: Record<string, string> = {
          GetProtocolInfo: "<Source></Source><Sink>http-get:*:video/x-matroska:*,http-get:*:video/mp2t:*</Sink>",
          GetTransportInfo: "<CurrentTransportState>STOPPED</CurrentTransportState><CurrentTransportStatus>OK</CurrentTransportStatus>",
        };
        return new Response(`<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/"><s:Body><u:${action}Response xmlns:u="x">${fields[action] ?? ""}</u:${action}Response></s:Body></s:Envelope>`);
      },
    });

    // A movie on disk
    root = await mkdtemp(join(tmpdir(), "findr-bridge-"));
    const path = join(root, "movie.mkv");
    await Bun.write(path, bytes);
    const probe: ProbeInfo = {
      durationMs: 7_200_000,
      bitrate: 8_000_000,
      startTime: 0,
      video: { index: 0, codec: "h264", width: 1920, height: 1080, bitDepth: 8, hdr: false, profile: "High", level: 41, frameRate: 23.976, transfer: "bt709" },
      audio: [{ index: 1, codec: "aac", channels: 2, language: "eng", title: null, isDefault: true }],
    };
    const title = Title.findOrCreate(603, "movie");
    MediaItem.upsert({ titleId: title.id, downloadId: null, season: null, episode: null, path, size: bytes.length, mtime: 1, probe, keyframes: Float64Array.from([0]) });
    movie = { titleId: title.id, season: null, episode: null };

    // The bridge, connected to the server
    const created = CastBridge.create("Home");
    bridge = created.bridge;
    const port = freePort();
    mediaUrl = `http://127.0.0.1:${port}`;
    agent = new BridgeAgent(
      { server: `http://127.0.0.1:${server.port}`, token: created.token, port, mediaUrl },
      { discover: async () => new Set([`http://127.0.0.1:${tv.port}/description.xml`]), onFatal: (reason) => fatal.push(reason) },
    );
    agent.start();
    await until(() => BridgeHub.getInstance().get(bridge.id)?.connected === true);
  });

  afterAll(async () => {
    await DlnaController.getInstance().stopAll();
    await agent.stop();
    await PlaybackService.getInstance().stop();
    await server.stop();
    tv.stop(true);
    await rm(root, { recursive: true, force: true });
  });

  test("a wrong token is refused before the connection opens", async () => {
    const response = await fetch(`http://127.0.0.1:${server.port}/api/playback/bridges/connect`, { headers: { Authorization: "Bearer fcb_wrong" } });
    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: "bridge_unknown" });
  });

  test("lists the bridge's TVs, named for where they are", async () => {
    const renderers = await DlnaController.getInstance().list(true);
    expect(renderers).toEqual([{ id: `${bridge.id}:den-tv`, name: "Den TV", manufacturer: null, model: null, direct: true, place: "Home" }]);
    expect(BridgeHub.getInstance().record(bridge, DlnaController.getInstance().countOn(bridge.id))).toMatchObject({ name: "Home", online: true, address: mediaUrl, renderers: 1 });
  });

  test("plays on a TV there, which fetches the file through the bridge", async () => {
    actions = [];
    const status = await DlnaController.getInstance().play(`${bridge.id}:den-tv`, { ...movie, startMs: 0, audioTrack: null, label: "The Matrix" }, viewer);
    expect(status.renderer.place).toBe("Home");

    // The TV was told to fetch from the bridge, not from the server
    const load = actions.find((entry) => entry.action === "SetAVTransportURI");
    const url = /<CurrentURI>([^<]+)<\/CurrentURI>/.exec(load?.body ?? "")?.[1]?.replaceAll("&amp;", "&") ?? "";
    expect(url).toStartWith(`${mediaUrl}/api/playback/stream/`);
    expect(actions.map((entry) => entry.action)).toContain("Play");

    // Fetching it as the TV would gets the file, by range too
    const whole = await fetch(url);
    expect(whole.status).toBe(200);
    expect(new Uint8Array(await whole.arrayBuffer())).toEqual(bytes);
    const part = await fetch(url, { headers: { range: "bytes=100-199" } });
    expect(part.status).toBe(206);
    expect(new Uint8Array(await part.arrayBuffer())).toEqual(bytes.slice(100, 200));
  }, 20_000);

  test("a removed bridge is disconnected, its TVs go, and it stops itself", async () => {
    bridge.delete();
    BridgeHub.getInstance().remove(bridge.id);
    await until(() => fatal.length === 1);
    expect(fatal[0]).toContain("removed this bridge");

    // Its TV stays only while still being driven
    await DlnaController.getInstance().stopAll();
    expect(await DlnaController.getInstance().list(true)).toEqual([]);
  });
});
