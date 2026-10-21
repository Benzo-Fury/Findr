import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, setSystemTime, test } from "bun:test";
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
import DlnaController from "./dlna/DlnaController";
import { DlnaRenderer } from "./dlna/DlnaRenderer";
import { Ssdp } from "./dlna/Ssdp";
import type { ProbeInfo } from "./MediaProbe";
import PlaybackService from "./PlaybackService";
import { WatchHistory } from "./WatchHistory";

// ---------- Trusting what answers a search ---------- //

describe("DLNA discovery", () => {
  let server: ReturnType<typeof Bun.serve>;
  let base: string;

  beforeAll(() => {
    server = Bun.serve({
      port: 0,
      fetch(request) {
        const path = new URL(request.url).pathname;
        // A device whose services point at another machine, with a name no code point can hold
        if (path === "/elsewhere.xml") {
          return new Response(`<?xml version="1.0"?>
<root><device><deviceType>urn:schemas-upnp-org:device:MediaRenderer:1</deviceType><friendlyName>Bad&#99999999;TV</friendlyName><UDN>uuid:elsewhere</UDN><serviceList>
  <service><serviceType>urn:schemas-upnp-org:service:AVTransport:1</serviceType><controlURL>http://10.9.9.9/av</controlURL></service>
  <service><serviceType>urn:schemas-upnp-org:service:RenderingControl:1</serviceType><controlURL>/rc</controlURL></service>
</serviceList></device></root>`);
        }
        if (path === "/redirect.xml") return Response.redirect("http://10.9.9.9/description.xml", 302);
        return new Response("not found", { status: 404 });
      },
    });
    base = `http://127.0.0.1:${server.port}`;
  });

  afterAll(() => server.stop(true));

  test("only takes a description URL on the device that answered", () => {
    expect(Ssdp.onDevice("http://192.168.1.40:8080/desc.xml", "192.168.1.40")).toBe(true);
    expect(Ssdp.onDevice("http://127.0.0.1:34571/api/settings", "192.168.1.40")).toBe(false);
    expect(Ssdp.onDevice("file:///etc/passwd", "192.168.1.40")).toBe(false);
    expect(Ssdp.onDevice("not a url", "192.168.1.40")).toBe(false);
  });

  test("drives no service that lives on another machine, and survives a broken description", async () => {
    // Its transport points elsewhere, so it can't be driven at all
    expect(await DlnaRenderer.open(`${base}/elsewhere.xml`)).toBeNull();
  });

  test("follows no redirect away from the device", async () => {
    expect(await DlnaRenderer.open(`${base}/redirect.xml`)).toBeNull();
  });
});

// ---------- Driving a TV ---------- //

/** UPnP transport states the fake TV moves through. */
type TvState = "NO_MEDIA_PRESENT" | "STOPPED" | "TRANSITIONING" | "PLAYING" | "PAUSED_PLAYBACK";

/**
 * A TV that behaves like the real ones Findr has met: told to play, it
 * reports PLAYING at once with the previous item's position while it is still
 * opening the file, and ignores seeks until the file has really started.
 * Times are real (`performance.now`), so freezing `Date` doesn't move it.
 */
class FakeTv {
  state: TvState = "NO_MEDIA_PRESENT";
  loads: string[] = [];
  seeks: number[] = [];
  /** How long it takes to open a file once told to play. */
  openMs = 2500;
  /** The previous item's position, reported while opening. */
  staleMs = 71_000;
  /** Never gets going: stays TRANSITIONING after Play. */
  neverStarts = false;
  private opensAt = 0;
  private since = 0;
  private base = 0;
  private frozen = 0;

  get opened(): boolean {
    return performance.now() >= this.opensAt;
  }

  position(): number {
    if (this.state === "PAUSED_PLAYBACK") return this.frozen;
    if (this.state !== "PLAYING") return 0;
    if (!this.opened) return this.staleMs;
    return this.base + (performance.now() - Math.max(this.since, this.opensAt));
  }

  handle(action: string, body: string): string {
    const field = (name: string) => new RegExp(`<${name}>([^<]*)</${name}>`).exec(body)?.[1] ?? "";
    switch (action) {
      case "SetAVTransportURI":
        this.loads.push(field("CurrentURI").replaceAll("&amp;", "&"));
        this.state = "STOPPED";
        return "";
      case "Play":
        if (this.neverStarts) {
          this.state = "TRANSITIONING";
          return "";
        }
        if (this.state === "PAUSED_PLAYBACK") {
          // Pausing while opening holds the opening back
          if (this.frozen === this.staleMs) this.opensAt = performance.now() + this.openMs;
          else this.base = this.frozen;
          this.since = performance.now();
        } else if (this.state !== "PLAYING") {
          this.opensAt = performance.now() + this.openMs;
          this.since = this.opensAt;
          this.base = 0;
        }
        this.state = "PLAYING";
        return "";
      case "Pause":
        this.frozen = this.position();
        this.state = "PAUSED_PLAYBACK";
        return "";
      case "Stop":
        this.state = "STOPPED";
        return "";
      case "Seek": {
        const target = DlnaRenderer.parseClock(field("Target"));
        this.seeks.push(target);
        // Quietly ignored while the file is still opening
        if (this.state === "PLAYING" && this.opened) {
          this.base = target;
          this.since = performance.now();
        }
        return "";
      }
      case "GetTransportInfo":
        return `<CurrentTransportState>${this.state}</CurrentTransportState><CurrentTransportStatus>OK</CurrentTransportStatus>`;
      case "GetPositionInfo":
        // It never knows the duration, as many TVs don't
        return `<Track>1</Track><TrackDuration>0:00:00</TrackDuration><RelTime>${DlnaRenderer.clock(this.position())}</RelTime>`;
      case "GetProtocolInfo":
        return "<Source></Source><Sink>http-get:*:video/x-matroska:*,http-get:*:video/mp2t:*,http-get:*:image/jpeg:*</Sink>";
      case "GetVolume":
        return "<CurrentVolume>20</CurrentVolume>";
      case "GetMute":
        return "<CurrentMute>0</CurrentMute>";
      default:
        return "";
    }
  }
}

const hasFfmpeg = Bun.which("ffmpeg") !== null && Bun.which("ffprobe") !== null;

// These run against the controller's real polling, every two seconds, so each gets 30 seconds
describe.skipIf(!hasFfmpeg)("DlnaController", () => {
  const viewer = "dlna-viewer";
  const other = "dlna-other";
  let tv: FakeTv;
  let server: ReturnType<typeof Bun.serve>;
  let root: string;
  let movie: PlaybackItemKey;
  let rendererId: string;
  const controller = () => DlnaController.getInstance();

  beforeAll(async () => {
    await migrateAuth();
    const now = new Date().toISOString();
    for (const id of [viewer, other]) {
      database.query("INSERT INTO user (id, name, email, emailVerified, createdAt, updatedAt) VALUES (?, ?, ?, 0, ?, ?)").run(id, id, `${id}@findr.local`, now, now);
    }
    SettingsStore.update({ playback: { enabled: true, casting: true, trickplay: false, castBaseUrl: "http://127.0.0.1:34571" } });
    await PlaybackService.getInstance().start();

    server = Bun.serve({
      port: 0,
      async fetch(request) {
        if (new URL(request.url).pathname === "/description.xml") {
          return new Response(`<?xml version="1.0"?>
<root><device><deviceType>urn:schemas-upnp-org:device:MediaRenderer:1</deviceType><friendlyName>Test TV</friendlyName><UDN>uuid:test-tv</UDN><serviceList>
  <service><serviceType>urn:schemas-upnp-org:service:AVTransport:1</serviceType><controlURL>/av</controlURL></service>
  <service><serviceType>urn:schemas-upnp-org:service:RenderingControl:1</serviceType><controlURL>/rc</controlURL></service>
  <service><serviceType>urn:schemas-upnp-org:service:ConnectionManager:1</serviceType><controlURL>/cm</controlURL></service>
</serviceList></device></root>`);
        }
        const action = /#(\w+)"/.exec(request.headers.get("soapaction") ?? "")?.[1] ?? "";
        const fields = tv.handle(action, await request.text());
        return new Response(`<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/"><s:Body><u:${action}Response xmlns:u="x">${fields}</u:${action}Response></s:Body></s:Envelope>`);
      },
    });

    // A two-hour movie on disk
    root = await mkdtemp(join(tmpdir(), "findr-dlna-"));
    const path = join(root, "movie.mkv");
    await Bun.write(path, new Uint8Array(4096));
    const probe: ProbeInfo = {
      durationMs: 7_200_000,
      bitrate: 8_000_000,
      startTime: 0,
      video: { index: 0, codec: "h264", width: 1920, height: 1080, bitDepth: 8, hdr: false, profile: "High", level: 41, frameRate: 23.976, transfer: "bt709" },
      audio: [{ index: 1, codec: "aac", channels: 2, language: "eng", title: null, isDefault: true }],
    };
    const title = Title.findOrCreate(8966, "movie");
    MediaItem.upsert({ titleId: title.id, downloadId: null, season: null, episode: null, path, size: 4096, mtime: 1, probe, keyframes: Float64Array.from([0]) });
    movie = { titleId: title.id, season: null, episode: null };
  });

  beforeEach(async () => {
    tv = new FakeTv();
    // A fresh renderer each time, since one that failed a file is offered streams from then on
    const renderer = await DlnaRenderer.open(`http://127.0.0.1:${server.port}/description.xml`);
    if (!renderer) throw new Error("the fake TV wasn't read");
    rendererId = renderer.id;
    controller()["renderers"].set(renderer.id, renderer);
    database.run("DELETE FROM playback_progress");
  });

  afterEach(async () => {
    setSystemTime();
    await controller().stopAll();
  });

  afterAll(async () => {
    await PlaybackService.getInstance().stop();
    server.stop(true);
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

  const play = (startMs: number | null) => controller().play(rendererId, { ...movie, startMs, audioTrack: null, label: "The Movie" }, viewer);
  const status = () => controller().status(rendererId, viewer);
  const saved = () => PlaybackProgress.find(viewer, movie)?.positionMs ?? null;

  test("resumes once the file really plays, keeping the resume point meanwhile", async () => {
    WatchHistory.report(viewer, { ...movie, sessionId: null, positionMs: 1_800_000, event: "stop" });
    await play(null);
    expect(tv.loads[0]).toEndWith("/media.mkv");

    // While it opens it shows as starting, and the stale position is never taken up or saved
    const seen: number[] = [];
    await until(() => {
      seen.push(status().positionMs);
      if (process.env.DLNA_DEBUG) console.log(status().state, status().positionMs, tv.state, Math.round(tv.position()), tv.seeks);
      expect(saved()).toBe(1_800_000);
      return status().state === "playing";
    }, 15_000);
    expect(seen).not.toContain(tv.staleMs);
    expect(tv.seeks.length).toBeGreaterThan(0);
    expect(status().positionMs).toBeGreaterThanOrEqual(1_800_000);
    expect(status().positionMs).toBeLessThan(1_800_000 + 10_000);
    // It played the file it was given, without a stream sent instead
    expect(tv.loads).toHaveLength(1);
  }, 30_000);

  test("waits out a pause before the resume lands, rather than sending a stream", async () => {
    WatchHistory.report(viewer, { ...movie, sessionId: null, positionMs: 1_800_000, event: "stop" });
    await play(null);
    await controller().command(rendererId, { action: "pause" }, viewer);
    expect(tv.state).toBe("PAUSED_PLAYBACK");
    await until(() => status().state === "paused");

    // Far past the 30 seconds a TV gets to start: still paused, still the file
    setSystemTime(new Date(Date.now() + 45_000));
    await Bun.sleep(2500);
    expect(tv.loads).toHaveLength(1);
    expect(status().state).toBe("paused");
    setSystemTime();

    // Playing again lets the resume finish
    await controller().command(rendererId, { action: "play" }, viewer);
    await until(() => status().state === "playing", 15_000);
    expect(status().positionMs).toBeGreaterThanOrEqual(1_800_000);
    expect(tv.loads).toHaveLength(1);
  }, 30_000);

  test("takes no position from a TV still showing its last item", async () => {
    await play(0);
    // The first poll, two seconds in, finds the TV opening and reporting 1:11
    await Bun.sleep(2300);
    expect(status().state).toBe("loading");
    expect(status().positionMs).toBe(0);

    await until(() => status().state === "playing");
    expect(status().positionMs).toBeLessThan(10_000);
  }, 30_000);

  test("sends a stream instead when the TV takes the file but never plays it", async () => {
    tv.neverStarts = true;
    await play(0);
    expect(tv.loads[0]).toEndWith("/media.mkv");

    setSystemTime(new Date(Date.now() + 16_000));
    await until(() => tv.loads.length === 2);
    expect(tv.loads[1]).toContain("/media.ts?start=0");
    expect(controller()["renderers"].get(rendererId)?.acceptsMatroska).toBe(false);
  }, 30_000);

  test("tells whose cast it is, and lets the TV go a minute after it stops", async () => {
    await play(0);
    await until(() => status().state === "playing");
    const sessionId = controller()["active"].get(rendererId)?.session.id ?? "";

    expect(status().mine).toBe(true);
    expect(controller().status(rendererId, other).mine).toBe(false);
    expect(controller().castsOf(viewer).map((cast) => cast.renderer.id)).toEqual([rendererId]);
    expect(controller().castsOf(other)).toEqual([]);
    await expect(controller().command(rendererId, { action: "pause" }, other)).rejects.toThrow("renderer_busy");

    // Stopped on the TV itself: kept a minute, then let go with its session
    tv.state = "STOPPED";
    await until(() => status().state === "stopped");
    setSystemTime(new Date(Date.now() + 61_000));
    await until(() => controller().castsOf(viewer).length === 0);
    expect(PlaybackService.getInstance().get(sessionId)).toBeNull();
  }, 30_000);
});
