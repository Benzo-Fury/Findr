import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PlaybackItemKey } from "@findr/types/playback";
import { migrateAuth } from "../auth/client";
import { database } from "../db/client";
import { MediaItem } from "../db/models/MediaItem";
import { PlaybackProgress } from "../db/models/PlaybackProgress";
import { SettingsStore } from "../db/models/SettingsStore";
import { Title } from "../db/models/Title";
import { BridgeAgent } from "./bridge/BridgeAgent";
import { CastTicket } from "./CastTicket";
import type { HttpExchange, HttpReply, RendererNetwork } from "./dlna/RendererNetwork";
import type { CastDevice, CastLink } from "./googlecast/CastLink";
import { type CastFrame, CastMessage } from "./googlecast/CastMessage";
import GoogleCastController from "./googlecast/GoogleCastController";
import { GoogleCastReceiver } from "./googlecast/GoogleCastReceiver";
import { Mdns } from "./googlecast/Mdns";
import type { ProbeInfo } from "./MediaProbe";
import PlaybackService, { CAST_PROFILES } from "./PlaybackService";
import { Renderers } from "./Renderers";
import { WatchHistory } from "./WatchHistory";

// ---------- Wire format ---------- //

describe("CastMessage", () => {
  test("encodes a length-framed message that decodes to the same", () => {
    const frame: CastFrame = { sourceId: "sender-findr", destinationId: "receiver-0", namespace: "urn:x-cast:com.google.cast.receiver", payload: '{"type":"GET_STATUS","requestId":1}' };
    const encoded = CastMessage.encode(frame);
    expect(encoded.readUInt32BE(0)).toBe(encoded.length - 4);
    expect(CastMessage.decode(encoded.subarray(4))).toEqual(frame);
  });

  test("skips binary messages and refuses malformed ones", () => {
    // payload_type 1 (binary) with a binary payload
    const binary = Buffer.from([0x08, 0x00, 0x12, 0x01, 0x61, 0x1a, 0x01, 0x62, 0x22, 0x01, 0x63, 0x28, 0x01, 0x3a, 0x01, 0x00]);
    expect(CastMessage.decode(binary)).toBeNull();
    expect(() => CastMessage.decode(Buffer.from([0x12, 0x09, 0x61]))).toThrow();
  });
});

// ---------- Trusting what answers a search ---------- //

/** A DNS name as uncompressed labels. */
function dnsName(name: string): Buffer {
  return Buffer.concat([...name.split(".").map((label) => Buffer.concat([Buffer.from([label.length]), Buffer.from(label)])), Buffer.from([0])]);
}

/** One resource record. */
function dnsRecord(name: string, type: number, data: Buffer): Buffer {
  const fixed = Buffer.alloc(10);
  fixed.writeUInt16BE(type, 0);
  fixed.writeUInt16BE(1, 2);
  fixed.writeUInt32BE(120, 4);
  fixed.writeUInt16BE(data.length, 8);
  return Buffer.concat([dnsName(name), fixed, data]);
}

/** An mDNS answer for a Cast device: PTR, TXT, SRV and an A record naming `address`. */
function castAnswer(txt: string[], address: string, port = 8009): Buffer {
  const instance = "Chromecast-abc._googlecast._tcp.local";
  const header = Buffer.alloc(12);
  header.writeUInt16BE(0x8400, 2);
  header.writeUInt16BE(4, 6);
  const srv = Buffer.alloc(6);
  srv.writeUInt16BE(port, 4);
  return Buffer.concat([
    header,
    dnsRecord("_googlecast._tcp.local", 12, dnsName(instance)),
    dnsRecord(instance, 16, Buffer.concat(txt.map((entry) => Buffer.concat([Buffer.from([entry.length]), Buffer.from(entry)])))),
    dnsRecord(instance, 33, Buffer.concat([srv, dnsName("abc.local")])),
    dnsRecord("abc.local", 1, Buffer.from(address.split(".").map(Number))),
  ]);
}

describe("Google Cast discovery", () => {
  test("reads a device's id, name, model and port from its answer", () => {
    const device = Mdns.parse(castAnswer(["id=abc123", "fn=Living room TV", "md=Chromecast Ultra"], "192.168.1.50", 8010), "192.168.1.50");
    expect(device).toEqual({ id: "abc123", name: "Living room TV", model: "Chromecast Ultra", host: "192.168.1.50", port: 8010 });
  });

  test("reaches a device where its answer came from, never the address it names", () => {
    expect(Mdns.parse(castAnswer(["id=abc123", "fn=TV"], "127.0.0.1"), "192.168.1.50")?.host).toBe("192.168.1.50");
  });

  test("leaves out speakers and speaker groups, which have no screen", () => {
    expect(Mdns.parse(castAnswer(["id=speaker", "fn=Kitchen speaker", "ca=2052"], "192.168.1.51"), "192.168.1.51")).toBeNull();
    expect(Mdns.parse(castAnswer(["id=tv", "fn=Living room TV", "ca=4101"], "192.168.1.50"), "192.168.1.50")?.id).toBe("tv");
  });

  test("ignores answers that name no device", () => {
    expect(Mdns.parse(castAnswer(["fn=No id"], "192.168.1.50"), "192.168.1.50")).toBeNull();
  });

  test("a bridge connects only to the port a Cast device it found advertised", async () => {
    const agent = new BridgeAgent(
      { server: "http://127.0.0.1:1", token: "t", port: 0, mediaUrl: null },
      { discover: async () => new Set(), discoverCast: async () => [{ id: "a", name: "TV", model: null, host: "192.168.1.50", port: 8009 }] },
    );
    await agent.searchCast();
    const socket = { readyState: 1, send: () => {} } as unknown as WebSocket;
    expect(agent.openCast(socket, "192.168.1.51", 8009)).rejects.toThrow("isn't a Cast device");
    expect(agent.openCast(socket, "192.168.1.50", 22)).rejects.toThrow("isn't a Cast device");
  });
});

// ---------- Tickets and profiles ---------- //

describe("Cast tickets for receivers Findr drives", () => {
  test("carry what the receiver decodes, and leave it out for one the browser cast to", () => {
    const data = { userId: "u", titleId: "t", season: 1, episode: 2, audioTrack: null, maxBitrate: null };
    expect(CastTicket.verify(CastTicket.issue(data))).toEqual(data);
    const driven = { ...data, capabilities: { hevc: true, uhd: false, hdr: false } };
    expect(CastTicket.verify(CastTicket.issue(driven))).toEqual(driven);
  });

  test("the receiver profiles match the Chromecast setting's", () => {
    expect(GoogleCastReceiver.profileOf({ hevc: false, uhd: false, hdr: false })).toEqual(CAST_PROFILES["1080p"]);
    expect(GoogleCastReceiver.profileOf({ hevc: true, uhd: true, hdr: true })).toEqual(CAST_PROFILES["4k-hdr"]);
  });
});

// ---------- Driving a receiver ---------- //

/** A running app, as the fake receiver reports it. */
interface FakeApp {
  appId: string;
  sessionId: string;
  transportId: string;
}

/**
 * A Cast device running Google's Default Media Receiver, answering over a
 * link the way a real one does: receiver status on the platform, media
 * status from the app, request ids echoed.
 */
class FakeReceiver {
  apps: FakeApp[] = [];
  loads: { url: string; currentTime: number; hls: unknown }[] = [];
  volume = { level: 0.5, muted: false };
  media: { mediaSessionId: number; playerState: string; currentTime: number; idleReason?: string } | null = null;
  private sessions = 0;

  /** A link to it, as a network's `openCast` returns. */
  link(): CastLink {
    const receiver = this;
    const link: CastLink = {
      closed: false,
      onMessage: null,
      onClose: null,
      send(frame) {
        const reply = receiver.handle(frame);
        if (reply) queueMicrotask(() => link.onMessage?.(reply));
      },
      close() {
        (link as { closed: boolean }).closed = true;
        link.onClose?.();
      },
    };
    return link;
  }

  /** Another phone casting something else replaces Findr's app. */
  takeOver(): void {
    this.apps = [{ appId: "OTHER", sessionId: "other", transportId: "other-t" }];
  }

  private handle(frame: CastFrame): CastFrame | null {
    const message = JSON.parse(frame.payload) as Record<string, unknown> & { type: string; requestId?: number };
    const answer = (sourceId: string, namespace: string, payload: object): CastFrame => ({
      sourceId,
      destinationId: frame.sourceId,
      namespace,
      payload: JSON.stringify({ ...payload, requestId: message.requestId }),
    });
    const receiverStatus = () => answer("receiver-0", frame.namespace, { type: "RECEIVER_STATUS", status: { applications: this.apps, volume: this.volume } });
    const mediaStatus = () => answer(frame.destinationId, frame.namespace, { type: "MEDIA_STATUS", status: this.media ? [this.media] : [] });

    // The platform
    if (frame.destinationId === "receiver-0") {
      switch (message.type) {
        case "LAUNCH":
          this.apps = [{ appId: String(message.appId), sessionId: `s${++this.sessions}`, transportId: `t${this.sessions}` }];
          return receiverStatus();
        case "STOP":
          this.apps = [];
          this.media = null;
          return receiverStatus();
        case "SET_VOLUME":
          Object.assign(this.volume, message.volume);
          return receiverStatus();
        case "GET_STATUS":
          return receiverStatus();
        default:
          return null;
      }
    }

    // The media app
    switch (message.type) {
      case "LOAD": {
        const media = message.media as { contentId: string; hlsSegmentFormat?: string };
        this.loads.push({ url: media.contentId, currentTime: Number(message.currentTime), hls: media.hlsSegmentFormat });
        this.media = { mediaSessionId: this.loads.length, playerState: "PLAYING", currentTime: Number(message.currentTime) };
        return mediaStatus();
      }
      case "PAUSE":
        if (this.media) this.media.playerState = "PAUSED";
        return mediaStatus();
      case "PLAY":
        if (this.media) this.media.playerState = "PLAYING";
        return mediaStatus();
      case "SEEK":
        if (this.media) this.media.currentTime = Number(message.currentTime);
        return mediaStatus();
      case "GET_STATUS":
        return mediaStatus();
      default:
        return null;
    }
  }
}

describe("Driving a Chromecast", () => {
  const viewer = "cast-viewer";
  const other = "cast-other";
  let fake: FakeReceiver;
  let root: string;
  let movie: PlaybackItemKey;
  let rendererId: string;
  const controller = () => GoogleCastController.getInstance();

  /** The server's own network, with one fake Cast device on it. */
  const network: RendererNetwork = {
    id: "local",
    place: null,
    local: true,
    connected: true,
    search: async () => new Set<string>(),
    request: async (_exchange: HttpExchange): Promise<HttpReply> => ({ status: 404, body: "" }),
    mediaBase: () => "http://192.168.1.20:34571",
    searchCast: async () => [],
    openCast: async (_device: CastDevice) => fake.link(),
  };

  beforeAll(async () => {
    await migrateAuth();
    const now = new Date().toISOString();
    for (const id of [viewer, other]) {
      database.query("INSERT OR IGNORE INTO user (id, name, email, emailVerified, createdAt, updatedAt) VALUES (?, ?, ?, 0, ?, ?)").run(id, id, `${id}@findr.local`, now, now);
    }
    SettingsStore.update({ playback: { enabled: true, casting: true, trickplay: false } });
    await PlaybackService.getInstance().start();

    // A two-hour movie on disk
    root = await mkdtemp(join(tmpdir(), "findr-cast-"));
    const path = join(root, "movie.mkv");
    await Bun.write(path, new Uint8Array(4096));
    const probe: ProbeInfo = {
      durationMs: 7_200_000,
      bitrate: 8_000_000,
      startTime: 0,
      video: { index: 0, codec: "h264", width: 1920, height: 1080, bitDepth: 8, hdr: false, profile: "High", level: 41, frameRate: 23.976, transfer: "bt709" },
      audio: [{ index: 1, codec: "aac", channels: 2, language: "eng", title: null, isDefault: true }],
    };
    const title = Title.findOrCreate(603, "movie");
    MediaItem.upsert({ titleId: title.id, downloadId: null, season: null, episode: null, path, size: 4096, mtime: 1, probe, keyframes: Float64Array.from([0]) });
    movie = { titleId: title.id, season: null, episode: null };
  });

  beforeEach(() => {
    fake = new FakeReceiver();
    const receiver = new GoogleCastReceiver({ id: "abc123", name: "Living room TV", model: "Chromecast", host: "192.168.1.50", port: 8009 }, network, () => ({ hevc: false, uhd: false, hdr: false }));
    rendererId = receiver.id;
    controller()["receivers"].set(receiver.id, receiver);
    database.run("DELETE FROM playback_progress");
  });

  afterEach(async () => {
    await controller().stopAll();
    controller()["receivers"].clear();
  });

  afterAll(async () => {
    await PlaybackService.getInstance().stop();
    await rm(root, { recursive: true, force: true });
  });

  /** Waits until a check passes, failing after `timeoutMs`. */
  async function until(check: () => boolean, timeoutMs = 10_000): Promise<void> {
    const deadline = performance.now() + timeoutMs;
    while (!check()) {
      if (performance.now() > deadline) throw new Error("timed out waiting");
      await Bun.sleep(100);
    }
  }

  const play = (startMs: number | null) => Renderers.of(rendererId).play(rendererId, { ...movie, startMs, audioTrack: null, label: "The Movie" }, viewer);

  test("is listed by name like any other TV, and routed to its own controller", () => {
    expect(controller().has(rendererId)).toBe(true);
    expect(Renderers.of(rendererId)).toBe(controller());
    expect(controller().status(rendererId, viewer).renderer).toMatchObject({ name: "Living room TV", place: null });
  });

  test("launches the media player and loads a cast URL at the resume point, as fragmented MP4 HLS", async () => {
    WatchHistory.report(viewer, { ...movie, sessionId: null, positionMs: 1_800_000, event: "stop" });
    const status = await play(null);

    expect(fake.apps[0]?.appId).toBe("CC1AD845");
    expect(fake.loads).toHaveLength(1);
    expect(fake.loads[0]?.url).toMatch(/^http:\/\/192\.168\.1\.20:34571\/api\/playback\/cast\/[^/]+\/index\.m3u8$/);
    expect(fake.loads[0]?.currentTime).toBe(1800);
    expect(fake.loads[0]?.hls).toBe("fmp4");
    expect(status).toMatchObject({ mine: true, label: "The Movie", positionMs: 1_800_000, durationMs: 7_200_000 });

    // The ticket asks for what this receiver decodes
    const ticket = /\/cast\/([^/]+)\//.exec(fake.loads[0]?.url ?? "")?.[1] ?? "";
    expect(CastTicket.verify(ticket)?.capabilities).toEqual({ hevc: false, uhd: false, hdr: false });
  });

  test("is driven from the remote, saving progress, and only by whoever started it", async () => {
    await play(0);
    await until(() => controller().status(rendererId, viewer).state === "playing");

    // Seek and pause, which saves where it is
    await controller().command(rendererId, { action: "seek", positionMs: 3_600_000 }, viewer);
    expect(fake.media?.currentTime).toBe(3600);
    await controller().command(rendererId, { action: "pause" }, viewer);
    expect(fake.media?.playerState).toBe("PAUSED");
    expect(PlaybackProgress.find(viewer, movie)?.positionMs).toBe(3_600_000);

    // Volume is anyone's; the rest is the viewer's
    await controller().command(rendererId, { action: "volume", volume: 30 }, other);
    expect(fake.volume.level).toBe(0.3);
    expect(controller().command(rendererId, { action: "play" }, other)).rejects.toMatchObject({ code: "renderer_busy" });

    // Stop closes the player and lets the receiver go
    await controller().command(rendererId, { action: "stop" }, viewer);
    expect(fake.apps).toHaveLength(0);
    expect(controller().castsOf(viewer)).toHaveLength(0);
  });

  test("lets go of a receiver another phone has cast to", async () => {
    await play(0);
    expect(controller().castsOf(viewer)).toHaveLength(1);
    fake.takeOver();
    // Let go at once, leaving the other phone's app playing
    await until(() => controller().castsOf(viewer).length === 0);
    expect(fake.apps[0]?.appId).toBe("OTHER");
  });

  test("shows the splash when picked, and clears it when unpicked", async () => {
    await controller().showSplash(rendererId, viewer);
    expect(fake.loads[0]?.url).toBe("http://192.168.1.20:34571/api/playback/splash");
    await controller().hideSplash(rendererId, viewer);
    expect(fake.apps).toHaveLength(0);
  });
});
