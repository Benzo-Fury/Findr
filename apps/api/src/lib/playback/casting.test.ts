import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import { type HardwareApi, HardwareApiSchema, type HardwareReport, PlaybackSettingsSchema } from "@findr/types/playback";
import { migrateAuth } from "../auth/client";
import { MediaItem } from "../db/models/MediaItem";
import { SettingsStore } from "../db/models/SettingsStore";
import { Title } from "../db/models/Title";
import { CastAccess } from "./CastAccess";
import { CastTicket } from "./CastTicket";
import { DlnaRenderer } from "./dlna/DlnaRenderer";
import { LocalRendererNetwork } from "./dlna/LocalRendererNetwork";
import { Upnp, UpnpError } from "./dlna/Upnp";
import { Ffmpeg } from "./Ffmpeg";
import HardwareProbe, { TranscodeLadder } from "./HardwareProbe";
import { type ProbeInfo, MediaProbe } from "./MediaProbe";
import { PlaybackDecider, type PlaybackPlan } from "./PlaybackDecider";
import { ProgressiveSession } from "./ProgressiveSession";
import { StreamToken } from "./StreamToken";
import { RUNGS, type Rung, type TranscodeSource, TranscodePipeline, type VideoArgs, type VideoEncode } from "./TranscodePipeline";
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

describe("TranscodePipeline", () => {
  const encode: VideoEncode = { scaleToHeight: 720, bitrateCap: null, bitrateEstimate: 4_000_000, toneMap: false, keyframeSeconds: 6 };
  const sdr: TranscodeSource = { width: 1920, height: 1080, bitDepth: 8 };
  const hdr: TranscodeSource = { width: 3840, height: 2160, bitDepth: 10 };
  const jellyfin = new Set(["tonemapx", "zscale", "tonemap"]);
  const build = (api: HardwareApi, rung: Rung, extra: Partial<VideoEncode> = {}, source = sdr, filters: ReadonlySet<string> = jellyfin) =>
    TranscodePipeline.build(api, rung, { ...encode, ...extra }, source, settings, filters);
  const line = (args: VideoArgs) => [...args.input, "-i", "IN", ...args.output].join(" ");

  test("encodes on the CPU by quality, capped when asked", () => {
    const { input, output } = build("none", "device");
    expect(input).toEqual([]);
    expect(output).toContain("libx264");
    expect(output.join(" ")).toContain("-crf 23");
    expect(output.join(" ")).toContain("-vf scale=-2:720,format=yuv420p");
    expect(build("none", "cpu", { bitrateCap: 3_000_000 }).output.join(" ")).toContain("-maxrate 3000000 -bufsize 6000000");
  });

  test("every API and rung places keyframes on segment boundaries without B-frames", () => {
    for (const api of HardwareApiSchema.options) {
      for (const rung of RUNGS) {
        for (const [extra, source] of [[{}, sdr], [{ toneMap: true, scaleToHeight: 1080 }, hdr], [{ scaleToHeight: null }, hdr]] as const) {
          const args = build(api, rung, extra, source);
          expect(args.output.join(" ")).toContain("-bf 0 -force_key_frames expr:gte(t,n_forced*6)");
          expect(args.output.join(" ")).toContain(`-c:v ${args.encoder}`);
          expect(args.encoder).toBe(args.rung === "cpu" ? "libx264" : TranscodePipeline.encoderName(api));
          // No empty filter steps, whatever was built
          expect(line(args)).not.toMatch(/,,|-vf ,|,( |$)/);
        }
      }
    }
  });

  test("VA-API opens its device and uploads frames after the CPU filters when only encoding", () => {
    const { input, output } = build("vaapi", "encode");
    expect(input).toEqual(["-vaapi_device", settings.vaapiDevice]);
    expect(output.join(" ")).toContain("-vf scale=-2:720,format=nv12,hwupload");
  });

  test("keeps 4K HDR on the device end to end where it can, scaling before tone mapping", () => {
    const args = build("videotoolbox", "device", { scaleToHeight: 1080, toneMap: true }, hdr);
    expect(args.rung).toBe("device");
    expect(line(args)).toBe(
      "-hwaccel videotoolbox -hwaccel_output_format videotoolbox_vld -i IN -c:v h264_videotoolbox -vf scale_vt=w=1920:h=1080:format=p010le,tonemap_videotoolbox=format=nv12:t=bt709:m=bt709:p=bt709:tonemap=bt2390 " +
        "-profile:v high -allow_sw 1 -b:v 4000000 -g 9999 -bf 0 -force_key_frames expr:gte(t,n_forced*6) -sc_threshold 0",
    );
    expect(line(build("vaapi", "device", { scaleToHeight: 1080, toneMap: true }, hdr))).toContain("-vf scale_vaapi=w=1920:h=1080:format=p010,tonemap_vaapi=format=nv12");
    expect(line(build("nvenc", "device", { scaleToHeight: 1080, toneMap: true }, hdr))).toContain("-hwaccel cuda -hwaccel_output_format cuda -i IN -c:v h264_nvenc -vf scale_cuda=w=1920:h=1080:format=p010le,tonemap_cuda=");
    expect(line(build("qsv", "device", { scaleToHeight: 1080, toneMap: true }, hdr))).toContain("-hwaccel vaapi -hwaccel_device va -hwaccel_output_format vaapi -i IN -c:v h264_qsv -vf hwmap=derive_device=qsv,vpp_qsv=w=1920:h=1080:format=p010,vpp_qsv=tonemap=1:format=nv12");
  });

  test("converts 10-bit SDR to 8-bit on the device, and passes 8-bit through untouched", () => {
    expect(line(build("vaapi", "device", { scaleToHeight: null }, hdr))).toContain("-vf scale_vaapi=format=nv12 ");
    expect(line(build("videotoolbox", "device", { scaleToHeight: null }))).not.toContain("-vf");
  });

  test("tone maps on Rockchip's Mali GPU through OpenCL, opened beside the decoder only when tone mapping", () => {
    expect(TranscodePipeline.deviceRungPossible("rkmpp", { ...encode, toneMap: true }, hdr)).toBe(true);
    const args = build("rkmpp", "device", { scaleToHeight: 1080, toneMap: true }, hdr);
    expect(args.rung).toBe("device");
    expect(line(args)).toContain(
      "-init_hw_device rkmpp=rk -init_hw_device opencl=ocl@rk -filter_hw_device ocl -hwaccel rkmpp -hwaccel_device rk -hwaccel_output_format drm_prime -i IN -c:v h264_rkmpp " +
        "-vf scale_rkrga=w=1920:h=1080:format=p010,hwmap=derive_device=opencl:mode=read,tonemap_opencl=format=nv12:t=bt709:m=bt709:p=bt709:tonemap=bt2390:peak=100:desat=0,hwmap=derive_device=rkmpp:mode=write:reverse=1,format=drm_prime ",
    );
    // Unscaled, the packed 10-bit frames still pass through the RGA to reach the GPU
    expect(line(build("rkmpp", "device", { scaleToHeight: null, toneMap: true }, hdr))).toContain("-vf scale_rkrga=format=p010,hwmap=derive_device=opencl");
    // Without tone mapping no OpenCL device is opened, so boards without it still decode on the hardware
    const plain = line(build("rkmpp", "device", { scaleToHeight: 1080 }, hdr));
    expect(plain).toContain("-vf scale_rkrga=w=1920:h=1080:format=nv12 ");
    expect(plain).not.toContain("opencl");
    // The decode rung still tone maps on the CPU, for when the GPU fails
    expect(line(build("rkmpp", "decode", { scaleToHeight: 1080, toneMap: true }, hdr))).toContain("-hwaccel rkmpp -hwaccel_output_format drm_prime -i IN");
  });

  test("brings frames back to the CPU only where the decoder left them on the device", () => {
    expect(line(build("amf", "device", { toneMap: true, scaleToHeight: 1080 }, hdr))).toContain("-hwaccel d3d11va -i IN -c:v h264_amf -vf scale=-2:1080,tonemapx=");
    expect(line(build("qsv", "decode", { scaleToHeight: null }, hdr))).toContain("-vf hwdownload,format=p010le,format=nv12 ");
  });

  test("passes Rockchip's packed 10-bit frames through the RGA before downloading them", () => {
    expect(line(build("rkmpp", "decode", { scaleToHeight: null, toneMap: true }, hdr))).toContain("-vf scale_rkrga=format=p010,hwdownload,format=p010le,tonemapx=");
    expect(TranscodePipeline.decodeCheck("rkmpp", true, settings)?.filters).toEqual(["scale_rkrga=format=p010", "hwdownload", "format=p010le"]);
    expect(TranscodePipeline.decodeCheck("rkmpp", false, settings)?.filters).toEqual(["hwdownload", "format=nv12"]);
  });

  test("tone maps on the CPU with tonemapx, else zscale, else not at all", () => {
    expect(line(build("none", "cpu", { toneMap: true }, hdr))).toContain("-vf scale=-2:720,tonemapx=");
    expect(line(build("none", "cpu", { toneMap: true }, hdr, new Set(["zscale", "tonemap"])))).toContain("-vf zscale=t=linear:npl=100,format=gbrpf32le,zscale=p=bt709,tonemap=tonemap=hable:desat=0,zscale=t=bt709:m=bt709:r=tv,scale=-2:720,format=yuv420p");
    expect(line(build("none", "cpu", { toneMap: true }, hdr, new Set()))).toContain("-vf scale=-2:720,format=yuv420p");
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

describe("Ffmpeg.transportStreamArgs", () => {
  /** A plan for an HEVC file on an H.264-only TV: video re-encoded, AAC audio copied or not. */
  const planFor = (audioCodecs: Array<"aac" | "mp3">, videoCodecs: Array<"h264" | "hevc"> = ["h264"]) =>
    PlaybackDecider.decide({
      probe: { ...probeStub(), video: { ...probeStub().video, codec: "hevc" } },
      audioStream: 1,
      profile: { videoCodecs, audioCodecs, maxHeight: 1080, hdr: false },
      maxBitrate: null,
      settings,
    });
  /** The output options between the input and `pipe:1`. */
  const output = (args: string[]) => args.slice(args.indexOf("-i") + 2).join(" ");
  /** x264 for a plan that encodes, as a ladder on the CPU rung builds it. */
  const video = (plan: PlaybackPlan) =>
    plan.video === "encode"
      ? TranscodePipeline.build("none", "cpu", { scaleToHeight: plan.scaleToHeight, bitrateCap: null, bitrateEstimate: 4_000_000, toneMap: plan.toneMap, keyframeSeconds: 2 }, { width: 1920, height: 1080, bitDepth: 8 }, settings, new Set())
      : null;
  const tsArgs = (plan: PlaybackPlan, startSeconds: number) => Ffmpeg.transportStreamArgs("/media/a.mkv", plan, startSeconds, video(plan));

  test("trims copied audio to the start when the video is re-encoded after a seek", () => {
    const line = output(tsArgs(planFor(["aac"]), 600));
    expect(line).toContain("-c:a copy -ss 0 ");
  });

  test("leaves the stream alone from the start, with converted audio, or with copied video", () => {
    expect(output(tsArgs(planFor(["aac"]), 0))).not.toContain("-ss");
    expect(output(tsArgs(planFor(["mp3"]), 600))).not.toContain("-ss");
    expect(output(tsArgs(planFor(["aac"], ["h264", "hevc"]), 600))).not.toContain("-ss");
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
        // Two TVs listing bare containers, one a Hisense VIDAA TV that says so in its description
        if (url.pathname === "/vidaa.xml" || url.pathname === "/bare.xml") {
          const description = url.pathname === "/vidaa.xml" ? "<modelDescription>#CAP#\nbrand=his\nvidaa_support=1\n</modelDescription>" : "";
          return new Response(`<?xml version="1.0"?>
<root xmlns="urn:schemas-upnp-org:device-1-0"><device><deviceType>urn:schemas-upnp-org:device:MediaRenderer:1</deviceType><friendlyName>Bedroom TV</friendlyName>${description}<UDN>uuid:bare</UDN>
<serviceList>
  <service><serviceType>urn:schemas-upnp-org:service:AVTransport:1</serviceType><controlURL>/upnp/control/AVTransport1</controlURL></service>
  <service><serviceType>urn:schemas-upnp-org:service:ConnectionManager:1</serviceType><controlURL>/bare/cm</controlURL></service>
</serviceList></device></root>`);
        }
        if (url.pathname === "/bare/cm") {
          return new Response(
            '<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/"><s:Body><u:GetProtocolInfoResponse xmlns:u="x"><Source></Source><Sink>http-get:*:video/mp4:*,http-get:*:video/x-matroska:*,http-get:*:video/mpeg:*,http-get:*:audio/aac:*</Sink></u:GetProtocolInfoResponse></s:Body></s:Envelope>',
          );
        }
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
    const listed = { hevc: true, uhd: false, hdr: false };
    expect(renderer?.toRecord()).toEqual({
      id: "1234-abcd",
      name: "Living Room TV & Sound",
      manufacturer: "Acme",
      model: "Screen 9000",
      direct: true,
      place: null,
      capabilities: listed,
      detected: listed,
      overrides: { hevc: null, uhd: null, hdr: null },
    });
    expect(renderer?.transportStreamType).toBe("video/vnd.dlna.mpeg-tts");


    expect(renderer?.matroskaType).toBe("video/x-matroska");
    expect(renderer?.profile).toEqual({
      videoCodecs: ["h264", "hevc"],
      audioCodecs: ["aac", "mp3", "ac3"],
      maxHeight: 1080,
      hdr: false,
      decoders: [{ codec: "hevc", maxHeight: 1080, tenBit: true, hdr: false }],
    });
  });

  test("takes an admin's corrections, and narrows itself on copies it never starts", async () => {
    // A renderer of its own, since what it learns sticks for as long as it runs
    const tv = await DlnaRenderer.open(location);
    if (!tv) throw new Error("the renderer wasn't read");

    // An admin's corrections win over what it lists, field by field
    tv.overrides = { hevc: null, uhd: true, hdr: true };
    expect(tv.capabilities).toEqual({ hevc: true, uhd: true, hdr: true });
    expect(tv.profile).toMatchObject({ maxHeight: 2160, hdr: true, decoders: [{ codec: "hevc", maxHeight: 2160, tenBit: true, hdr: true }] });

    // Copies it never started narrow it, the most specific thing first, for as long as it runs
    const hevc = { codec: "hevc", height: 2160, bitDepth: 10, hdr: true };
    tv.recordCopyFailure(hevc);
    expect(tv.capabilities).toEqual({ hevc: true, uhd: true, hdr: false });
    tv.recordCopyFailure(hevc);
    expect(tv.profile.decoders).toEqual([{ codec: "hevc", maxHeight: 2160, tenBit: false, hdr: false }]);
    tv.recordCopyFailure(hevc);
    expect(tv.capabilities).toEqual({ hevc: true, uhd: false, hdr: false });
    tv.recordCopyFailure(hevc);
    expect(tv.profile.videoCodecs).toEqual(["h264"]);
  });

  test("takes HEVC on a Hisense VIDAA TV whose formats never name it", async () => {
    const vidaa = await DlnaRenderer.open(location.replace("description.xml", "vidaa.xml"));
    const bare = await DlnaRenderer.open(location.replace("description.xml", "bare.xml"));
    expect(vidaa?.profile.videoCodecs).toEqual(["h264", "hevc"]);
    expect(vidaa?.acceptsMatroska).toBe(true);
    expect(bare?.profile.videoCodecs).toEqual(["h264"]);
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
    const silent = await Upnp.call(LocalRendererNetwork.instance, slow, "Play", { InstanceID: 0, Speed: 1 }, 50).catch((error: unknown) => error);
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
    return new ProgressiveSession({ id: "s", userId: "u", item, plan, settings, ladder: null, direct, transportStreamType: "video/mpeg", matroskaType: "video/x-mkv", deviceName: "TV", audioLanguage: null, startMs: 0 });
  }

  test("serves the file as it is, whole or by byte range", async () => {
    const session = open(true);
    const whole = await session.serve(new Request("http://tv/media.mkv"), 0);
    expect(whole.status).toBe(200);
    expect(whole.headers.get("content-length")).toBe(String(item.size));
    // Labelled with the type the TV listed, not Findr's own name for it
    expect(whole.headers.get("content-type")).toBe("video/x-mkv");
    expect(whole.headers.get("contentfeatures.dlna.org")).toContain("DLNA.ORG_OP=01");

    const part = await session.serve(new Request("http://tv/media.mkv", { headers: { Range: "bytes=100-199" } }), 0);
    expect(part.status).toBe(206);
    expect(part.headers.get("content-range")).toBe(`bytes 100-199/${item.size}`);
    expect((await part.arrayBuffer()).byteLength).toBe(100);

    const tail = await session.serve(new Request("http://tv/media.mkv", { headers: { Range: "bytes=-50" } }), 0);
    expect(tail.headers.get("content-range")).toBe(`bytes ${item.size - 50}-${item.size - 1}/${item.size}`);

    const beyond = await session.serve(new Request("http://tv/media.mkv", { headers: { Range: `bytes=${item.size}-` } }), 0);
    expect(beyond.status).toBe(416);
  });

  test("streams MPEG-TS from a start time, converting audio the TV can't take", async () => {
    const session = open(false);
    expect(session.plan.audio).toBe("encode");
    const response = await session.serve(new Request("http://tv/media.ts"), 20_000);
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

  test("sends a TV a stream that started, stepping down from hardware that fails before its first bytes", async () => {
    // HEVC only on an H.264 TV, so the video is re-encoded, with a ladder claiming VA-API works here
    const plan = PlaybackDecider.decide({
      probe: item.probe,
      audioStream: item.probe.audio[0]?.index ?? 1,
      profile: { videoCodecs: ["hevc"], audioCodecs: ["aac", "mp3"], maxHeight: 1080, hdr: false },
      maxBitrate: null,
      settings,
    });
    expect(plan.video).toBe("encode");
    const report: HardwareReport = { configured: "vaapi", api: "vaapi", encoder: "h264_vaapi", encodes: true, decodes: ["h264"], scales: true, toneMaps: true, message: null, durationMs: 0 };
    const hardware = HardwareProbe.getInstance();
    hardware.forget();
    const ladder = new TranscodeLadder(hardware, report, plan, { width: item.probe.video.width, height: item.probe.video.height, bitDepth: 8 }, settings, "h264");
    const session = new ProgressiveSession({ id: "ladder", userId: "u", item, plan, settings, ladder, direct: false, transportStreamType: "video/mpeg", matroskaType: "video/x-mkv", deviceName: "TV", audioLanguage: null, startMs: 0 });
    try {
      const response = await session.serve(new Request("http://tv/media.ts"), 20_000);
      expect(response.status).toBe(200);
      const bytes = new Uint8Array(await response.arrayBuffer());
      expect(bytes[0]).toBe(0x47);
      expect(ladder.rung).toBe("cpu");
      expect(session.hardware).toBe(false);
    } finally {
      await session.close();
      hardware.forget();
    }
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
