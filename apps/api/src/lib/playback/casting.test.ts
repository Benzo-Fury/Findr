import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import { PlaybackSettingsSchema } from "@findr/types/playback";
import { migrateAuth } from "../auth/client";
import { MediaItem } from "../db/models/MediaItem";
import { SettingsStore } from "../db/models/SettingsStore";
import { Title } from "../db/models/Title";
import { CastAccess } from "./CastAccess";
import { CastTicket } from "./CastTicket";
import { DlnaRenderer } from "./dlna/DlnaRenderer";
import { Upnp, UpnpError } from "./dlna/Upnp";
import { Ffmpeg } from "./Ffmpeg";
import { type ProbeInfo, MediaProbe } from "./MediaProbe";
import { PlaybackDecider } from "./PlaybackDecider";
import { ProgressiveSession } from "./ProgressiveSession";
import { StreamToken } from "./StreamToken";
import { Trickplay } from "./Trickplay";

const settings = PlaybackSettingsSchema.parse({});

beforeAll(async () => {
  await migrateAuth();
});

// ---------- Tickets and access ---------- //

describe("CastTicket", () => {
  const data = { userId: "user-1", titleId: "title-1", season: 1, episode: 4, audioTrack: null, maxBitrate: 6_000_000 };

  test("carries what to play and who cast it", () => {
    expect(CastTicket.verify(CastTicket.issue(data))).toEqual(data);
  });

  test("refuses a ticket that was altered, forged or has expired", () => {
    const ticket = CastTicket.issue(data);
    const [payload, expires, signature] = ticket.split(".");
    const altered = Buffer.from(JSON.stringify({ u: "admin", t: "title-1", s: 1, e: 4, a: null, b: null })).toString("base64url");
    expect(CastTicket.verify(`${altered}.${expires}.${signature}`)).toBeNull();
    expect(CastTicket.verify(`${payload}.${expires}.${"x".repeat(32)}`)).toBeNull();
    expect(CastTicket.verify(CastTicket.issue(data, Date.now() - 13 * 60 * 60 * 1000))).toBeNull();
  });

  test("is not a stream token, nor the other way round", () => {
    expect(StreamToken.verify(CastTicket.issue(data))).toBeNull();
    expect(CastTicket.verify(StreamToken.issue("session-1"))).toBeNull();
  });
});

describe("CastAccess", () => {
  const app = new Hono();
  app.all("*", (c) => c.text(String(CastAccess.allows(c))));
  const ask = async (path: string) => (await app.request(path)).text();

  test("lets TVs fetch media with a valid token or ticket while casting is on", async () => {
    SettingsStore.update({ playback: { enabled: true, casting: true } });
    const token = StreamToken.issue("session-1");
    const ticket = CastTicket.issue({ userId: "u", titleId: "t", season: null, episode: null, audioTrack: null, maxBitrate: null });
    expect(await ask(`/api/playback/stream/${token}/3.m4s`)).toBe("true");
    expect(await ask(`/api/playback/cast/${ticket}/index.m3u8`)).toBe("true");
  });

  test("refuses other paths, bad credentials, and everything while casting or playback is off", async () => {
    SettingsStore.update({ playback: { enabled: true, casting: true } });
    const token = StreamToken.issue("session-1");
    expect(await ask(`/api/playback/stream/forged.token.signature/3.m4s`)).toBe("false");
    expect(await ask(`/api/playback/library`)).toBe("false");
    expect(await ask(`/api/playback/stream/${token}/3.m4s/extra`)).toBe("false");

    SettingsStore.update({ playback: { casting: false } });
    expect(await ask(`/api/playback/stream/${token}/3.m4s`)).toBe("false");
    SettingsStore.update({ playback: { casting: true, enabled: false } });
    expect(await ask(`/api/playback/stream/${token}/3.m4s`)).toBe("false");
    SettingsStore.update({ playback: { enabled: true } });
  });
});

// ---------- Encoders ---------- //

describe("Ffmpeg.videoEncode", () => {
  const encode = { scaleToHeight: 720, bitrateCap: null, bitrateEstimate: 4_000_000, toneMap: false, keyframeSeconds: 6 };
  const args = (acceleration: (typeof settings)["hardwareAcceleration"], cap: number | null = null) =>
    Ffmpeg.videoEncode({ ...settings, hardwareAcceleration: acceleration }, { ...encode, bitrateCap: cap });

  test("encodes on the CPU by quality, capped when asked", () => {
    const { input, output } = args("none");
    expect(input).toEqual([]);
    expect(output).toContain("libx264");
    expect(output.join(" ")).toContain("-crf 23");
    expect(output.join(" ")).toContain("-vf scale=-2:720,format=yuv420p");
    expect(args("none", 3_000_000).output.join(" ")).toContain("-maxrate 3000000 -bufsize 6000000");
  });

  test("every encoder places keyframes on segment boundaries without B-frames", () => {
    for (const acceleration of ["none", "videotoolbox", "nvenc", "qsv", "vaapi", "amf", "rkmpp"] as const) {
      const line = args(acceleration).output.join(" ");
      expect(line).toContain("-bf 0 -force_key_frames expr:gte(t,n_forced*6)");
      expect(line).toContain(`-c:v ${Ffmpeg.encoderName(acceleration)}`);
    }
  });

  test("VA-API opens its device and uploads frames after the CPU filters", () => {
    const { input, output } = args("vaapi");
    expect(input).toEqual(["-vaapi_device", settings.vaapiDevice]);
    expect(output.join(" ")).toContain("-vf scale=-2:720,format=nv12,hwupload");
  });

  test("tone maps only when asked and the filter exists", () => {
    const decided = PlaybackDecider.decide({
      probe: { ...probeStub(), video: { ...probeStub().video, hdr: true, height: 2160, width: 3840 } },
      audioStream: 1,
      profile: { videoCodecs: ["h264"], audioCodecs: ["aac"], maxHeight: 1080, hdr: false },
      maxBitrate: null,
      settings,
    });
    expect(decided.toneMap).toBe(true);
    expect(decided.reasons).toContain("hdr");
    const off = PlaybackDecider.decide({
      probe: { ...probeStub(), video: { ...probeStub().video, hdr: true } },
      audioStream: 1,
      profile: { videoCodecs: ["h264"], audioCodecs: ["aac"], maxHeight: 1080, hdr: false },
      maxBitrate: null,
      settings: { ...settings, toneMapping: false },
    });
    expect(off.toneMap).toBe(false);
  });
});

function probeStub(): ProbeInfo {
  return {
    durationMs: 60_000,
    bitrate: 8_000_000,
    startTime: 0,
    video: { index: 0, codec: "h264", width: 1920, height: 1080, bitDepth: 8, hdr: false },
    audio: [{ index: 1, codec: "aac", channels: 2, language: "eng", title: null, isDefault: true }],
  };
}

// ---------- DLNA ---------- //

describe("DlnaRenderer", () => {
  /** SOAP requests the fake TV received, by action. */
  const received: Array<{ action: string; body: string }> = [];
  let server: ReturnType<typeof Bun.serve>;
  let location: string;

  beforeAll(() => {
    server = Bun.serve({
      port: 0,
      async fetch(request) {
        const url = new URL(request.url);
        // A speaker: a media server's services listed first, then its renderer's, which take audio only
        if (url.pathname === "/speaker.xml") {
          return new Response(`<?xml version="1.0"?>
<root xmlns="urn:schemas-upnp-org:device-1-0"><device><deviceType>urn:schemas-upnp-org:device:ZonePlayer:1</deviceType><friendlyName>Kitchen</friendlyName><UDN>uuid:speaker</UDN>
<deviceList>
  <device><deviceType>urn:schemas-upnp-org:device:MediaServer:1</deviceType><serviceList>
    <service><serviceType>urn:schemas-upnp-org:service:ConnectionManager:1</serviceType><controlURL>/server/cm</controlURL></service>
  </serviceList></device>
  <device><deviceType>urn:schemas-upnp-org:device:MediaRenderer:1</deviceType><serviceList>
    <service><serviceType>urn:schemas-upnp-org:service:AVTransport:1</serviceType><controlURL>/speaker/av</controlURL></service>
    <service><serviceType>urn:schemas-upnp-org:service:ConnectionManager:1</serviceType><controlURL>/speaker/cm</controlURL></service>
  </serviceList></device>
</deviceList></device></root>`);
        }
        if (url.pathname === "/server/cm") return new Response("nothing here", { status: 500 });
        // A TV that takes its time over an action
        if (url.pathname === "/slow") {
          await Bun.sleep(300);
          return new Response("late");
        }
        if (url.pathname === "/speaker/cm") {
          return new Response(
            '<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/"><s:Body><u:GetProtocolInfoResponse xmlns:u="x"><Source></Source><Sink>http-get:*:audio/mpeg:*,http-get:*:audio/flac:*</Sink></u:GetProtocolInfoResponse></s:Body></s:Envelope>',
          );
        }
        if (url.pathname === "/description.xml") {
          return new Response(`<?xml version="1.0"?>
<root xmlns="urn:schemas-upnp-org:device-1-0">
  <device>
    <deviceType>urn:schemas-upnp-org:device:MediaRenderer:1</deviceType>
    <friendlyName>Living Room TV &amp; Sound</friendlyName>
    <manufacturer>Acme</manufacturer>
    <modelName>Screen 9000</modelName>
    <UDN>uuid:1234-abcd</UDN>
    <serviceList>
      <service><serviceType>urn:schemas-upnp-org:service:AVTransport:1</serviceType><controlURL>/upnp/control/AVTransport1</controlURL></service>
      <service><serviceType>urn:schemas-upnp-org:service:RenderingControl:1</serviceType><controlURL>upnp/control/RenderingControl1</controlURL></service>
      <service><serviceType>urn:schemas-upnp-org:service:ConnectionManager:1</serviceType><controlURL>/upnp/control/ConnectionManager1</controlURL></service>
    </serviceList>
  </device>
</root>`);
        }

        // Answer each action the way a TV would
        const action = /#(\w+)"/.exec(request.headers.get("soapaction") ?? "")?.[1] ?? "";
        const body = await request.text();
        received.push({ action, body });
        const fields: Record<string, string> = {
          GetProtocolInfo: "<Source></Source><Sink>http-get:*:video/mp4:*,http-get:*:video/x-matroska:*,http-get:*:video/vnd.dlna.mpeg-tts:DLNA.ORG_PN=AVC_TS_HD_50_AC3,http-get:*:video/mp4:DLNA.ORG_PN=HEVC_MP4_HD</Sink>",
          GetTransportInfo: "<CurrentTransportState>PAUSED_PLAYBACK</CurrentTransportState><CurrentTransportStatus>OK</CurrentTransportStatus>",
          GetPositionInfo: "<Track>1</Track><TrackDuration>1:02:03</TrackDuration><RelTime>0:10:05.500</RelTime>",
          GetVolume: "<CurrentVolume>17</CurrentVolume>",
          GetMute: "<CurrentMute>0</CurrentMute>",
        };
        if (action === "Seek" && body.includes("9:59:59")) {
          return new Response(
            '<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/"><s:Body><s:Fault><detail><UPnPError><errorCode>711</errorCode><errorDescription>Illegal seek target</errorDescription></UPnPError></detail></s:Fault></s:Body></s:Envelope>',
            { status: 500 },
          );
        }
        return new Response(
          `<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/"><s:Body><u:${action}Response xmlns:u="x">${fields[action] ?? ""}</u:${action}Response></s:Body></s:Envelope>`,
          { headers: { "Content-Type": "text/xml" } },
        );
      },
    });
    location = `http://127.0.0.1:${server.port}/description.xml`;
  });

  afterAll(() => server.stop(true));

  test("reads a renderer's description and the formats it takes", async () => {
    const renderer = await DlnaRenderer.open(location);
    expect(renderer?.toRecord()).toEqual({ id: "1234-abcd", name: "Living Room TV & Sound", manufacturer: "Acme", model: "Screen 9000", direct: true });
    expect(renderer?.transportStreamType).toBe("video/vnd.dlna.mpeg-tts");
    expect(renderer?.matroskaType).toBe("video/x-matroska");
    expect(renderer?.profile).toEqual({ videoCodecs: ["h264", "hevc"], audioCodecs: ["aac", "mp3", "ac3"], maxHeight: 1080, hdr: false });
  });

  test("drives the transport and reads back its state", async () => {
    const renderer = await DlnaRenderer.open(location);
    if (!renderer) throw new Error("no renderer");
    received.length = 0;

    await renderer.load("http://192.168.1.2:34571/api/playback/stream/a.b.c/media.mkv", "<DIDL-Lite><item/></DIDL-Lite>");
    await renderer.play();
    await renderer.seek(3_725_000);
    expect(received.map((entry) => entry.action)).toEqual(["SetAVTransportURI", "Play", "Seek"]);
    // Metadata travels as escaped text inside the SOAP body
    expect(received[0]?.body).toContain("<CurrentURIMetaData>&lt;DIDL-Lite&gt;&lt;item/&gt;&lt;/DIDL-Lite&gt;</CurrentURIMetaData>");
    expect(received[2]?.body).toContain("<Target>1:02:05</Target>");

    expect(await renderer.state()).toBe("paused");
    expect(await renderer.position()).toEqual({ positionMs: 605_500, durationMs: 3_723_000 });
    expect(await renderer.volume()).toEqual({ volume: 17, muted: false });
  });

  test("leaves out speakers, reading the renderer's own services", async () => {
    expect(await DlnaRenderer.open(location.replace("description.xml", "speaker.xml"))).toBeNull();
  });

  test("reports the renderer's UPnP error", async () => {
    const renderer = await DlnaRenderer.open(location);
    await expect(renderer?.seek(35_999_000)).rejects.toThrow("Illegal seek target");
  });

  test("tells a TV that refused from one that never answered", async () => {
    const renderer = await DlnaRenderer.open(location);
    const refused = await renderer?.seek(35_999_000).catch((error: unknown) => error);
    expect(refused).toBeInstanceOf(UpnpError);
    expect((refused as UpnpError).answered).toBe(true);

    const slow = { serviceType: "urn:schemas-upnp-org:service:AVTransport:1", controlUrl: location.replace("description.xml", "slow") };
    const silent = await Upnp.call(slow, "Play", { InstanceID: 0, Speed: 1 }, 50).catch((error: unknown) => error);
    expect(silent).toBeInstanceOf(UpnpError);
    expect((silent as UpnpError).answered).toBe(false);
  });

  test("reads and writes UPnP clock times", () => {
    expect(DlnaRenderer.clock(3_725_999)).toBe("1:02:05");
    expect(DlnaRenderer.parseClock("0:00:01.25")).toBe(1250);
    expect(DlnaRenderer.parseClock("NOT_IMPLEMENTED")).toBe(0);
  });
});

// ---------- Progressive streams and thumbnails (need ffmpeg) ---------- //

const hasFfmpeg = Bun.which("ffmpeg") !== null && Bun.which("ffprobe") !== null;

describe.skipIf(!hasFfmpeg)("Progressive streams and thumbnails", () => {
  let root: string;
  let item: MediaItem;

  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), "findr-casting-"));
    const source = join(root, "source.mkv");
    await Bun.$`ffmpeg -v error -y -f lavfi -i testsrc2=size=320x180:rate=24 -f lavfi -i sine=frequency=440:sample_rate=48000 -t 25 -c:v libx264 -preset ultrafast -g 48 -c:a ac3 ${source}`.quiet();
    const prober = new MediaProbe();
    const probe = await prober.probe(source);
    const title = Title.findOrCreate(77, "movie");
    item = MediaItem.upsert({ titleId: title.id, downloadId: null, season: null, episode: null, path: source, size: Bun.file(source).size, mtime: 1, probe, keyframes: await prober.keyframes(source, probe.startTime) });
  });

  afterAll(async () => {
    await rm(root, { recursive: true, force: true });
  });

  function open(direct: boolean) {
    const plan = PlaybackDecider.decide({
      probe: item.probe,
      audioStream: item.probe.audio[0]?.index ?? 1,
      profile: { videoCodecs: ["h264"], audioCodecs: ["aac", "mp3"], maxHeight: 1080, hdr: false },
      maxBitrate: null,
      settings,
    });
    return new ProgressiveSession({ id: "s", userId: "u", item, plan, settings, direct, transportStreamType: "video/mpeg", matroskaType: "video/x-mkv", deviceName: "TV", audioLanguage: null, startMs: 0 });
  }

  test("serves the file as it is, whole or by byte range", async () => {
    const session = open(true);
    const whole = session.serve(new Request("http://tv/media.mkv"), 0);
    expect(whole.status).toBe(200);
    expect(whole.headers.get("content-length")).toBe(String(item.size));
    // Labelled with the type the TV listed, not Findr's own name for it
    expect(whole.headers.get("content-type")).toBe("video/x-mkv");
    expect(whole.headers.get("contentfeatures.dlna.org")).toContain("DLNA.ORG_OP=01");

    const part = session.serve(new Request("http://tv/media.mkv", { headers: { Range: "bytes=100-199" } }), 0);
    expect(part.status).toBe(206);
    expect(part.headers.get("content-range")).toBe(`bytes 100-199/${item.size}`);
    expect((await part.arrayBuffer()).byteLength).toBe(100);

    const tail = session.serve(new Request("http://tv/media.mkv", { headers: { Range: "bytes=-50" } }), 0);
    expect(tail.headers.get("content-range")).toBe(`bytes ${item.size - 50}-${item.size - 1}/${item.size}`);

    const beyond = session.serve(new Request("http://tv/media.mkv", { headers: { Range: `bytes=${item.size}-` } }), 0);
    expect(beyond.status).toBe(416);
  });

  test("streams MPEG-TS from a start time, converting audio the TV can't take", async () => {
    const session = open(false);
    expect(session.plan.audio).toBe("encode");
    const response = session.serve(new Request("http://tv/media.ts"), 20_000);
    const bytes = new Uint8Array(await response.arrayBuffer());
    await session.close();

    // TS packets are 188 bytes, each starting with 0x47
    expect(bytes.length).toBeGreaterThan(188 * 10);
    expect(bytes[0]).toBe(0x47);
    expect(bytes[188]).toBe(0x47);

    // About five seconds remain after starting at 20
    const file = join(root, "out.ts");
    await Bun.write(file, bytes);
    const duration = Number((await Bun.$`ffprobe -v error -show_entries format=duration -of csv=p=0 ${file}`.text()).trim());
    expect(duration).toBeGreaterThan(4);
    expect(duration).toBeLessThan(6.5);
    // ffprobe lists a transport stream's streams again under its program
    const codecs = new Set((await Bun.$`ffprobe -v error -show_entries stream=codec_name -of csv=p=0 ${file}`.text()).split("\n").filter(Boolean));
    expect([...codecs]).toEqual(["h264", "aac"]);
  });

  test("makes scrubbing thumbnails and a storyboard pointing at their tiles", async () => {
    await Ffmpeg.available();
    const directory = join(root, "trickplay");
    await Trickplay.generate(item, { ...settings, trickplayIntervalSeconds: 5, trickplayWidth: 160 }, new AbortController().signal, directory);

    const files = (await readdir(directory)).sort();
    expect(files).toEqual(["1.jpg", "meta.json", "storyboard.vtt"]);
    const storyboard = await readFile(join(directory, "storyboard.vtt"), "utf8");
    expect(storyboard.startsWith("WEBVTT")).toBe(true);
    expect(storyboard).toContain(`00:00:00.000 --> 00:00:05.000\n/api/playback/trickplay/${item.id}/1.jpg#xywh=0,0,160,90`);
    expect(storyboard).toContain(`00:00:20.000 --> 00:00:25.000\n/api/playback/trickplay/${item.id}/1.jpg#xywh=640,0,160,90`);
    expect(storyboard.match(/-->/g)?.length).toBe(5);
  });
});
