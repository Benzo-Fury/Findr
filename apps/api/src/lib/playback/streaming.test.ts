/**
 * End-to-end tests of watching in the browser and on a TV: a session made by
 * the playback service and played the way a player plays it, through the
 * real route chain, from its multivariant playlist down to its segments. The
 * socket address is faked by handing `fetch` a stand-in Bun server.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DeviceProfile } from "@findr/types/playback";
import { migrateAuth } from "../auth/client";
import { database } from "../db/client";
import { MediaItem } from "../db/models/MediaItem";
import { SettingsStore } from "../db/models/SettingsStore";
import { Title } from "../db/models/Title";
import { Server } from "../server/Server";
import { ServerAddress } from "../server/ServerAddress";
import { MediaProbe } from "./MediaProbe";
import PlaybackService from "./PlaybackService";

const hasFfmpeg = Bun.which("ffmpeg") !== null && Bun.which("ffprobe") !== null;

/** A browser that plays H.264 and AAC up to 1080p. */
const browser: DeviceProfile = { videoCodecs: ["h264"], audioCodecs: ["aac"], maxHeight: 1080, hdr: false };

describe.skipIf(!hasFfmpeg)("Streaming through the server", () => {
  const server = new Server();
  const viewer = "stream-viewer";
  let root: string;
  let titleId: string;

  /** Fetches a path through the app as if from `address`. */
  const get = (path: string, address = "127.0.0.1") =>
    server.fetch(new Request(`${ServerAddress.localUrl}${path}`), { requestIP: () => ({ address, family: "IPv4", port: 50000 }) });

  beforeAll(async () => {
    await migrateAuth();
    await server.constructRoutes();
    const now = new Date().toISOString();
    database
      .query("INSERT INTO user (id, name, email, emailVerified, createdAt, updatedAt) VALUES (?, ?, ?, 0, ?, ?)")
      .run(viewer, viewer, `${viewer}@findr.local`, now, now);

    // A 12-second H.264 + AC-3 file, so the audio has to be converted for the browser
    root = await mkdtemp(join(tmpdir(), "findr-streaming-"));
    const source = join(root, "film.mkv");
    await Bun.$`ffmpeg -v error -y -f lavfi -i testsrc2=size=320x180:rate=24 -f lavfi -i sine=frequency=440:sample_rate=48000 -t 12 -c:v libx264 -preset ultrafast -g 48 -c:a ac3 ${source}`.quiet();
    const prober = new MediaProbe();
    const probe = await prober.probe(source);
    titleId = Title.findOrCreate(5001, "movie").id;
    MediaItem.upsert({
      titleId,
      downloadId: null,
      season: null,
      episode: null,
      path: source,
      size: Bun.file(source).size,
      mtime: 1,
      probe,
      keyframes: await prober.keyframes(source, probe.startTime),
    });

    SettingsStore.update({
      access: { allowRemote: false },
      playback: { enabled: true, casting: true, trickplay: false, transcodesPath: join(root, "transcodes"), castBaseUrl: "http://192.168.1.10:34571" },
    });
    await PlaybackService.getInstance().start();
  }, 60_000);

  afterAll(async () => {
    await PlaybackService.getInstance().stop();
    await rm(root, { recursive: true, force: true });
  });

  test("plays from the playlist down to its segments under the signed path", async () => {
    const record = await PlaybackService.getInstance().create(
      { titleId, season: null, episode: null, deviceProfile: browser, maxBitrate: null, audioTrack: null, startMs: null },
      { userId: viewer, local: true },
    );
    expect(record.mode).toBe("audio");
    expect(record.castUrl).toStartWith("http://192.168.1.10:34571/api/playback/cast/");
    expect(record.remoteUrl).toBe(`http://192.168.1.10:34571${record.playlistUrl}`);
    const base = record.playlistUrl.replace(/index\.m3u8$/, "");

    // The multivariant playlist names the codecs and points at the media playlist
    const multivariant = await get(record.playlistUrl);
    expect(multivariant.status).toBe(200);
    expect(multivariant.headers.get("content-type")).toBe("application/vnd.apple.mpegurl");
    const variant = await multivariant.text();
    expect(variant).toContain('CODECS="avc1.');
    expect(variant).toContain("mp4a.40.2");
    const mediaPath = variant.split("\n").find((line) => line && !line.startsWith("#")) ?? "";
    expect(mediaPath).toBe("media.m3u8");

    // The media playlist lists the whole runtime, with its init section
    const media = await (await get(`${base}${mediaPath}`)).text();
    expect(media).toContain("#EXT-X-ENDLIST");
    const init = /#EXT-X-MAP:URI="([^"]+)"/.exec(media)?.[1] ?? "";
    const segments = media.split("\n").filter((line) => line && !line.startsWith("#"));
    expect(segments.length).toBeGreaterThan(0);

    // fMP4: the init section opens with ftyp, each segment holds a moof
    const initBytes = new Uint8Array(await (await get(`${base}${init}`)).arrayBuffer());
    expect(new TextDecoder().decode(initBytes.slice(4, 8))).toBe("ftyp");
    for (const segment of [segments[0], segments.at(-1)]) {
      const response = await get(`${base}${segment}`);
      expect(response.status).toBe(200);
      expect(response.headers.get("content-type")).toBe("video/iso.segment");
      expect(new TextDecoder().decode(new Uint8Array(await response.arrayBuffer()))).toContain("moof");
    }

    await PlaybackService.getInstance().end(record.id, viewer);
    expect((await get(record.playlistUrl)).status).toBe(404);
  }, 60_000);

  test("lets a TV on the network fetch media with remote access off, and nothing else", async () => {
    const record = await PlaybackService.getInstance().create(
      { titleId, season: null, episode: null, deviceProfile: browser, maxBitrate: null, audioTrack: null, startMs: null },
      { userId: viewer, local: true },
    );
    try {
      const tv = "192.168.1.50";
      expect((await get(record.playlistUrl, tv)).status).toBe(200);
      expect((await get("/api/playback/splash", tv)).headers.get("content-type")).toBe("image/jpeg");
      // A forged token, another path, or a public address are all refused
      expect((await get(record.playlistUrl.replace(/\/stream\/[^/]+\//, "/stream/forged.token.signature/"), tv)).status).toBe(403);
      expect((await get("/api/playback/casts", tv)).status).toBe(403);
      expect((await get(record.playlistUrl, "203.0.113.9")).status).toBe(403);
    } finally {
      await PlaybackService.getInstance().end(record.id, viewer);
    }
  }, 60_000);
});
