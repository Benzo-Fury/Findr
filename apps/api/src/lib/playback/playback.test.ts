import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type DeviceProfile, PlaybackSettingsSchema } from "@findr/types/playback";
import { migrateAuth } from "../auth/client";
import { database } from "../db/client";
import { MediaItem } from "../db/models/MediaItem";
import { PlaybackProgress } from "../db/models/PlaybackProgress";
import { SettingsStore } from "../db/models/SettingsStore";
import { Title } from "../db/models/Title";
import { HlsVariant } from "./HlsVariant";
import { LocalNetwork } from "./LocalNetwork";
import { type ProbeInfo, MediaProbe } from "./MediaProbe";
import { PlaybackDecider, TranscodeRequiredError } from "./PlaybackDecider";
import { PlaybackSession } from "./PlaybackSession";
import { SegmentPlan } from "./SegmentPlan";
import { StreamToken } from "./StreamToken";
import { WatchHistory } from "./WatchHistory";

const settings = PlaybackSettingsSchema.parse({});

/** A browser that plays H.264 and HEVC with AAC, AC-3 and E-AC-3, up to 1080p, without HDR. */
const browser: DeviceProfile = { videoCodecs: ["h264", "hevc"], audioCodecs: ["aac", "ac3", "eac3"], maxHeight: 1080, hdr: false };

/** A 1080p H.264 file with one audio track of the given codec. */
function probeOf(
  overrides: { codec?: string; height?: number; bitDepth?: number; hdr?: boolean; audio?: string; bitrate?: number; profile?: string; level?: number | null; transfer?: string } = {},
): ProbeInfo {
  return {
    durationMs: 7_200_000,
    bitrate: overrides.bitrate ?? 8_000_000,
    startTime: 0,
    video: {
      index: 0,
      codec: overrides.codec ?? "h264",
      width: 1920,
      height: overrides.height ?? 1080,
      bitDepth: overrides.bitDepth ?? 8,
      hdr: overrides.hdr ?? false,
      profile: overrides.profile ?? "High",
      level: overrides.level === undefined ? 41 : overrides.level,
      frameRate: 23.976,
      transfer: overrides.transfer ?? "bt709",
    },
    audio: [{ index: 1, codec: overrides.audio ?? "aac", channels: 6, language: "eng", title: null, isDefault: true }],
  };
}

// ---------- Decisions ---------- //

describe("PlaybackDecider", () => {
  const decide = (probe: ProbeInfo, extra: { maxBitrate?: number | null; transcoding?: boolean } = {}) =>
    PlaybackDecider.decide({
      probe,
      audioStream: 1,
      profile: browser,
      maxBitrate: extra.maxBitrate ?? null,
      settings: { ...settings, transcoding: extra.transcoding ?? true },
    });

  test("copies a file the device can play as it is", () => {
    const plan = decide(probeOf());
    expect(plan.mode).toBe("remux");
    expect(plan.reasons).toEqual([]);
  });

  test("converts only the audio when the device can't decode it", () => {
    const plan = decide(probeOf({ audio: "dts" }));
    expect(plan.mode).toBe("audio");
    expect(plan.video).toBe("copy");
    expect(plan.reasons).toEqual(["audio_codec:dts"]);
  });

  test.each([
    [{ codec: "mpeg4" }, "video_codec:mpeg4"],
    [{ bitDepth: 10 }, "bit_depth"],
    [{ height: 2160 }, "resolution"],
    [{ codec: "hevc", hdr: true }, "hdr"],
  ])("transcodes for %p", (overrides, reason) => {
    const plan = decide(probeOf(overrides));
    expect(plan.mode).toBe("transcode");
    expect(plan.reasons).toContain(reason);
  });

  test("transcodes under a bitrate cap, leaving room for converted audio", () => {
    const plan = decide(probeOf({ audio: "dts", bitrate: 20_000_000 }), { maxBitrate: 4_000_000 });
    expect(plan.mode).toBe("transcode");
    expect(plan.reasons).toContain("bitrate_cap");
    expect(plan.videoBitrateCap).toBe(4_000_000 - 192_000);
  });

  test("scales down to the device and never above the source", () => {
    expect(decide(probeOf({ height: 2160 })).scaleToHeight).toBe(1080);
    expect(decide(probeOf({ codec: "mpeg4", height: 720 })).scaleToHeight).toBeNull();
  });

  test("transcodes H.264 above the level a device decodes, trusting a file probed without one", () => {
    const cast = { ...browser, maxH264Level: 41 };
    const at = (level: number | null) => PlaybackDecider.decide({ probe: probeOf({ level }), audioStream: 1, profile: cast, maxBitrate: null, settings });
    expect(at(51).reasons).toEqual(["h264_level"]);
    expect(at(41).mode).toBe("remux");
    expect(at(null).mode).toBe("remux");
  });

  test("refuses when only a transcode would play and transcoding is off", () => {
    expect(() => decide(probeOf({ codec: "mpeg4" }), { transcoding: false })).toThrow(TranscodeRequiredError);
    expect(decide(probeOf({ audio: "dts" }), { transcoding: false }).mode).toBe("audio");
  });
});

// ---------- Multivariant playlist ---------- //

describe("HlsVariant", () => {
  const planFor = (probe: ProbeInfo, profile: DeviceProfile = browser) =>
    PlaybackDecider.decide({ probe, audioStream: 1, profile, maxBitrate: null, settings });

  test("names a copied stream's codecs, size, frame rate and range", () => {
    const probe = probeOf();
    const playlist = HlsVariant.playlist(probe, planFor(probe), "media.m3u8");
    expect(playlist.startsWith("#EXTM3U\n")).toBe(true);
    expect(playlist).toContain("#EXT-X-STREAM-INF:BANDWIDTH=8800000,AVERAGE-BANDWIDTH=8000000,");
    expect(playlist).toContain('CODECS="avc1.640029,mp4a.40.2",RESOLUTION=1920x1080,FRAME-RATE=23.976,VIDEO-RANGE=SDR\nmedia.m3u8');
  });

  test("describes HDR HEVC sent as it is", () => {
    const probe = probeOf({ codec: "hevc", profile: "Main 10", level: 153, bitDepth: 10, hdr: true, transfer: "smpte2084", audio: "eac3" });
    const playlist = HlsVariant.playlist(probe, planFor(probe, { ...browser, hdr: true }), "media.m3u8");
    expect(playlist).toContain('CODECS="hvc1.2.4.L153.90,ec-3"');
    expect(playlist).toContain("VIDEO-RANGE=PQ");
  });

  test("describes an encode by what the encoder makes", () => {
    const probe = probeOf({ codec: "hevc", profile: "Main 10", level: 153, height: 2160, hdr: true, transfer: "smpte2084", audio: "dts" });
    const plan = planFor(probe);
    expect(plan.toneMap).toBe(true);
    const playlist = HlsVariant.playlist({ ...probe, video: { ...probe.video, width: 3840 } }, plan, "media.m3u8");
    expect(playlist).toContain('CODECS="avc1.640029,mp4a.40.2",RESOLUTION=1920x1080');
    expect(playlist).toContain("VIDEO-RANGE=SDR");
  });

  test("leaves codecs out rather than guess", () => {
    const probe = probeOf({ profile: "Something New" });
    expect(HlsVariant.playlist(probe, planFor(probe), "media.m3u8")).not.toContain("CODECS");
    expect(HlsVariant.codecs(probeOf({ level: null }), planFor(probeOf()))).toBeNull();
  });
});

// ---------- Segments ---------- //

describe("SegmentPlan", () => {
  test("cuts copied video on the first keyframe a segment length after the last cut", () => {
    const keyframes = Float64Array.from([0, 2, 4, 6.5, 8, 10, 12.5, 14, 19, 20]);
    const plan = SegmentPlan.fromKeyframes(keyframes, 21, 6);
    expect(plan.starts).toEqual([0, 6.5, 12.5, 19]);
    expect(plan.length(3)).toBe(2);
  });

  test("never leaves a sliver of a last segment", () => {
    const plan = SegmentPlan.fromKeyframes(Float64Array.from([0, 6, 11.5]), 12, 6);
    expect(plan.starts).toEqual([0, 6]);
  });

  test("cuts encoded video every segment length", () => {
    expect(SegmentPlan.fixed(20, 6).starts).toEqual([0, 6, 12, 18]);
    expect(SegmentPlan.fixed(18.5, 6).starts).toEqual([0, 6, 12]);
  });

  test("finds the segment a moment falls in, allowing for rounding before a cut", () => {
    const plan = SegmentPlan.fixed(30, 6);
    expect(plan.indexAt(0)).toBe(0);
    expect(plan.indexAt(13)).toBe(2);
    expect(plan.indexAt(11.95, 0.1)).toBe(2);
    expect(plan.indexAt(11.95)).toBe(1);
  });

  test("lists every segment in a VOD playlist", () => {
    const playlist = SegmentPlan.fixed(14, 6).playlist();
    expect(playlist).toContain("#EXT-X-PLAYLIST-TYPE:VOD");
    expect(playlist).toContain('#EXT-X-MAP:URI="init.mp4"');
    expect(playlist).toContain("#EXT-X-TARGETDURATION:6");
    expect(playlist).toContain("#EXTINF:2.000000,\n2.m4s");
    expect(playlist.trim().endsWith("#EXT-X-ENDLIST")).toBe(true);
    expect(playlist).not.toContain("#EXT-X-START");
  });

  test("tells the player where a resumed session begins", () => {
    expect(SegmentPlan.fixed(14, 6).playlist(7.5)).toContain("#EXT-X-START:TIME-OFFSET=7.500,PRECISE=YES");
  });
});

// ---------- Access ---------- //

describe("StreamToken", () => {
  test("grants the session it was issued for", () => {
    expect(StreamToken.verify(StreamToken.issue("abc"))).toBe("abc");
  });

  test("rejects a forged, altered or expired token", () => {
    const token = StreamToken.issue("abc");
    const [id, expires, signature] = token.split(".");
    expect(StreamToken.verify(`other.${expires}.${signature}`)).toBeNull();
    expect(StreamToken.verify(`${id}.${expires}.${"A".repeat(32)}`)).toBeNull();
    expect(StreamToken.verify(`${token}.extra`)).toBeNull();
    expect(StreamToken.verify(token, Date.now() + 13 * 60 * 60 * 1000)).toBeNull();
  });
});

describe("LocalNetwork", () => {
  test.each([
    ["127.0.0.1", true],
    ["10.1.2.3", true],
    ["172.20.0.5", true],
    ["172.32.0.5", false],
    ["192.168.1.20", true],
    ["::ffff:192.168.1.20", true],
    ["169.254.10.1", true],
    ["8.8.8.8", false],
    ["::1", true],
    ["fd12:3456::1", true],
    ["fe80::1", true],
    ["2001:4860::8888", false],
  ])("%s is private: %p", (address, expected) => {
    expect(LocalNetwork.isPrivate(address)).toBe(expected);
  });
});

// ---------- Watch history ---------- //

describe("WatchHistory", () => {
  const userId = "user-1";
  let show: Title;
  let movie: Title;

  beforeAll(async () => {
    await migrateAuth();
    const now = new Date().toISOString();
    database
      .query("INSERT INTO user (id, name, email, emailVerified, createdAt, updatedAt) VALUES (?, ?, ?, 0, ?, ?)")
      .run(userId, "Viewer", "viewer@findr.local", now, now);
  });

  beforeEach(() => {
    database.run("DELETE FROM titles");
    show = Title.findOrCreate(1399, "tv");
    movie = Title.findOrCreate(603, "movie");

    // A ten-minute movie and three hour-long episodes
    const add = (titleId: string, season: number | null, episode: number | null, durationMs: number) =>
      MediaItem.upsert({
        titleId,
        downloadId: null,
        season,
        episode,
        path: `/library/${titleId}-${season}-${episode}.mkv`,
        size: 1,
        mtime: 1,
        probe: { ...probeOf(), durationMs },
        keyframes: Float64Array.from([0]),
      });
    add(movie.id, null, null, 600_000);
    for (const episode of [1, 2, 3]) add(show.id, 1, episode, 3_600_000);
  });

  const episode = (number: number) => ({ titleId: show.id, season: 1, episode: number });

  test("keeps a resume point between the minimum and maximum shares", () => {
    WatchHistory.report(userId, { ...episode(1), sessionId: null, positionMs: 1_200_000, event: "pause" });
    expect(PlaybackProgress.find(userId, episode(1))?.positionMs).toBe(1_200_000);
  });

  test("records nothing for a barely started item", () => {
    WatchHistory.report(userId, { ...episode(1), sessionId: null, positionMs: 60_000, event: "stop" });
    expect(PlaybackProgress.find(userId, episode(1))).toBeNull();
  });

  test("marks an item played past the maximum share and clears its resume point", () => {
    WatchHistory.report(userId, { ...episode(1), sessionId: null, positionMs: 3_400_000, event: "stop" });
    const progress = PlaybackProgress.find(userId, episode(1));
    expect(progress?.played).toBe(true);
    expect(progress?.positionMs).toBe(0);
    expect(progress?.playCount).toBe(1);
  });

  test("keeps no resume point for an item shorter than the minimum duration", () => {
    SettingsStore.update({ playback: { minResumeDurationSeconds: 900 } });
    WatchHistory.report(userId, { titleId: movie.id, season: null, episode: null, sessionId: null, positionMs: 300_000, event: "stop" });
    expect(PlaybackProgress.find(userId, { titleId: movie.id, season: null, episode: null })).toBeNull();
    SettingsStore.update({ playback: { minResumeDurationSeconds: 300 } });
  });

  test("suggests the next episode after the last one finished, and continues what was started", () => {
    WatchHistory.markPlayed(userId, episode(1), true);
    let library = WatchHistory.library(userId);
    expect(library.nextUp).toEqual([episode(2)]);
    expect(library.items).toHaveLength(4);

    // Starting episode 2 moves it from next up to continue watching
    WatchHistory.report(userId, { ...episode(2), sessionId: null, positionMs: 1_800_000, event: "tick" });
    library = WatchHistory.library(userId);
    expect(library.continueWatching).toEqual([episode(2)]);
    expect(library.nextUp).toEqual([]);
  });

  test("ignores items that aren't indexed", () => {
    expect(WatchHistory.report(userId, { ...episode(9), sessionId: null, positionMs: 1, event: "tick" })).toBe(false);
  });
});

// ---------- Packaging (needs ffmpeg) ---------- //

const hasFfmpeg = Bun.which("ffmpeg") !== null && Bun.which("ffprobe") !== null;

describe.skipIf(!hasFfmpeg)("Packaging", () => {
  let root: string;
  let source: string;
  let probe: ProbeInfo;
  let keyframes: Float64Array;

  beforeAll(async () => {
    // A 30-second H.264 + AC-3 file with a keyframe every 2.5 seconds
    root = await mkdtemp(join(tmpdir(), "findr-playback-"));
    source = join(root, "source.mkv");
    await Bun.$`ffmpeg -v error -y -f lavfi -i testsrc2=size=320x180:rate=24 -f lavfi -i sine=frequency=440:sample_rate=48000 -t 30 -c:v libx264 -preset ultrafast -g 60 -keyint_min 60 -bf 2 -c:a ac3 ${source}`.quiet();

    const prober = new MediaProbe();
    probe = await prober.probe(source);
    keyframes = await prober.keyframes(source, probe.startTime);
  });

  afterAll(async () => {
    await rm(root, { recursive: true, force: true });
  });

  test("probes streams, duration and keyframes", () => {
    expect(probe.video.codec).toBe("h264");
    expect(probe.audio[0]?.codec).toBe("ac3");
    expect(probe.video.frameRate).toBe(24);
    expect(probe.video.level).toBeGreaterThan(0);
    expect(HlsVariant.codecs(probe, { ...PlaybackDecider.decide({ probe, audioStream: probe.audio[0]?.index ?? 1, profile: browser, maxBitrate: null, settings }) })).toMatch(/^avc1\.[0-9a-f]{6},ac-3$/);
    expect(Math.round(probe.durationMs / 1000)).toBe(30);
    expect([...keyframes].slice(0, 3)).toEqual([0, 2.5, 5]);
  });

  /** Decode times of each track in a segment, read back with ffprobe through its init section. */
  async function segmentStart(directory: string, index: number): Promise<number> {
    const joined = join(directory, `joined-${index}.mp4`);
    const bytes = new Blob([await readFile(join(directory, "init.mp4")), await readFile(join(directory, `${index}.m4s`))]);
    await Bun.write(joined, bytes);
    const output = await Bun.$`ffprobe -v error -select_streams v:0 -show_entries packet=pts_time -of csv=p=0 -read_intervals %+#1 ${joined}`.text();
    return Number(output.trim().split("\n")[0]);
  }

  /** A session over the test file under the given plan. */
  async function openSession(mode: "copy" | "encode") {
    const title = Title.findOrCreate(42, "movie");
    const item = MediaItem.upsert({
      titleId: title.id,
      downloadId: null,
      season: null,
      episode: null,
      path: source,
      size: 1,
      mtime: 1,
      probe,
      keyframes,
    });
    const profile: DeviceProfile = mode === "copy" ? browser : { ...browser, videoCodecs: ["hevc"] };
    const plan = PlaybackDecider.decide({ probe, audioStream: 1, profile, maxBitrate: null, settings });
    const directory = join(root, `session-${mode}`);
    await Bun.$`mkdir -p ${directory}`;
    return {
      directory,
      session: new PlaybackSession({ id: mode, userId: "nobody", item, plan, settings, directory, startMs: 0, audioLanguage: null, device: "browser", warm: true }),
    };
  }

  test.each(["copy", "encode"] as const)("serves %s segments on the file's timeline, before and after a seek", async (mode) => {
    const { directory, session } = await openSession(mode);
    try {
      // Copied video cuts on its 2.5 s keyframes; encoded video every 6 s
      expect(session.segments.count).toBe(mode === "copy" ? 4 : 5);

      // Asking for a later segment first starts the run part-way through the file
      const seek = session.segments.count - 2;
      await session.segment(seek);
      await session.init();
      expect(await segmentStart(directory, seek)).toBeCloseTo(session.segments.start(seek), 1);

      // Going back to the start restarts the run there, on the same timeline and init
      await session.segment(0);
      expect(await segmentStart(directory, 0)).toBeCloseTo(0, 1);
      await session.segment(seek + 1);
      expect(await segmentStart(directory, seek + 1)).toBeCloseTo(session.segments.start(seek + 1), 1);
    } finally {
      await session.close();
    }
  }, 60_000);
});
