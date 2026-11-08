import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { copyFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MediaItem } from "../db/models/MediaItem";
import { Title } from "../db/models/Title";
import { type BlackFrame, CreditsDetector, POINT_SECONDS } from "./credits/CreditsDetector";
import CreditsLocator from "./credits/CreditsLocator";
import { TheIntroDb, TheIntroDbUnavailableError } from "./credits/TheIntroDb";
import type { ProbeInfo } from "./MediaProbe";

// ---------- TheIntroDB ---------- //

describe("TheIntroDb", () => {
  const hits: string[] = [];
  let server: ReturnType<typeof Bun.serve>;
  const original = TheIntroDb.baseUrl;

  beforeAll(() => {
    // Episode 1 has credits, 2 has none, 3 is an error
    server = Bun.serve({
      port: 0,
      fetch(request) {
        const url = new URL(request.url);
        hits.push(url.search);
        const episode = url.searchParams.get("episode");
        if (episode === "1") return Response.json({ tvdb_id: 81189, type: "tv", season: 1, episode: 1, credits: [{ start_ms: 3_433_269, end_ms: null }] });
        if (episode === "2") return Response.json({ error: "no_submissions" }, { status: 404 });
        return new Response("down", { status: 503 });
      },
    });
    TheIntroDb.baseUrl = `http://127.0.0.1:${server.port}`;
  });

  afterAll(() => {
    TheIntroDb.baseUrl = original;
    server.stop(true);
  });

  test("asks by TMDB id, season, episode and the file's length", async () => {
    expect(await TheIntroDb.credits(1396, 1, 1, 3_486_482)).toBe(3_433_269);
    expect(hits.at(-1)).toBe("?tmdb_id=1396&season=1&episode=1&duration_ms=3486482");
  });

  test("tells no data from no answer", async () => {
    expect(await TheIntroDb.credits(1396, 1, 2, 2_892_889)).toBeNull();
    await expect(TheIntroDb.credits(1396, 1, 3, 2_892_889)).rejects.toBeInstanceOf(TheIntroDbUnavailableError);
  });

  test("takes the earliest end-credits segment, skipping empty, early and out-of-range ones", () => {
    const duration = 3_000_000;
    expect(TheIntroDb.parse({ credits: [{ start_ms: 2_900_000, end_ms: null }, { start_ms: 2_800_000, end_ms: 2_850_000 }] }, duration)).toBe(2_800_000);
    expect(TheIntroDb.parse({ credits: [{ start_ms: 2_800_000, end_ms: 0 }] }, duration)).toBeNull();
    expect(TheIntroDb.parse({ credits: [{ start_ms: 600_000, end_ms: 700_000 }] }, duration)).toBeNull();
    expect(TheIntroDb.parse({ credits: [{ start_ms: 3_100_000, end_ms: null }] }, duration)).toBeNull();
    expect(TheIntroDb.parse({ credits: [{ start_ms: null, end_ms: null }] }, duration)).toBeNull();
    expect(TheIntroDb.parse({ intro: [{ start_ms: 0, end_ms: 30_000 }] }, duration)).toBeNull();
    expect(TheIntroDb.parse(null, duration)).toBeNull();
  });
});

// ---------- Audio fingerprints ---------- //

describe("CreditsDetector.match", () => {
  /** A repeatable stream of random 32-bit points. */
  function noise(length: number, seed: number): Uint32Array {
    const points = new Uint32Array(length);
    let state = seed;
    for (let index = 0; index < length; index++) {
      state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;
      points[index] = state;
    }
    return points;
  }

  /** Copies `shared` into `into` at `at`, flipping a few bits of each point as a re-encode would. */
  function plant(into: Uint32Array, shared: Uint32Array, at: number): void {
    shared.forEach((point, index) => (into[at + index] = (point ^ (1 << index % 32) ^ (1 << (index * 7) % 32)) >>> 0));
  }

  const seconds = (count: number) => Math.round(count / POINT_SECONDS);
  const length = seconds(300);

  test("finds a shared closing theme at a different offset in each episode", () => {
    const theme = noise(seconds(50), 7);
    const a = noise(length, 1);
    const b = noise(length, 2);
    plant(a, theme, length - theme.length);
    plant(b, theme, length - theme.length - seconds(8));

    const match = CreditsDetector.match(a, b);
    expect(match).not.toBeNull();
    expect(match?.a).toBe(length - theme.length);
    expect(match?.b).toBe(length - theme.length - seconds(8));
    expect(match?.points).toBe(theme.length);
  });

  test("finds the theme in an episode that follows its credits with a scene", () => {
    const theme = noise(seconds(90), 8);
    const a = noise(length, 12);
    const b = noise(length, 13);
    plant(a, theme, seconds(60));
    plant(b, theme, length - theme.length);
    expect(CreditsDetector.match(a, b)?.a).toBe(seconds(60));
  });

  test("ignores a studio logo's few seconds, a run far from the end, and unrelated endings", () => {
    const sting = noise(seconds(8), 9);
    const a = noise(length, 3);
    const b = noise(length, 4);
    plant(a, sting, length - sting.length);
    plant(b, sting, length - sting.length);
    expect(CreditsDetector.match(a, b)).toBeNull();

    // A shared stretch of score in the middle of the window, not the credits
    const score = noise(seconds(40), 11);
    plant(a, score, seconds(60));
    plant(b, score, seconds(70));
    expect(CreditsDetector.match(a, b)).toBeNull();
    expect(CreditsDetector.match(noise(length, 5), noise(length, 6))).toBeNull();
  });
});

// ---------- Black frames ---------- //

describe("CreditsDetector.blackRun", () => {
  /** Keyframes as `seconds:percent`, in the order ffmpeg logs them. */
  const frames = (spec: string): BlackFrame[] =>
    spec.split(" ").map((entry) => {
      const [seconds = "0", percent = "0"] = entry.split(":");
      return { seconds: Number(seconds), percent: Number(percent) };
    });

  test("finds credits on black that run to a closing logo, as in Breaking Bad S01E03", () => {
    // Real keyframes of the last minute: credits at 2843.0 s, the logo from 2881 s, the file 2891.9 s long
    const run = CreditsDetector.blackRun(frames("2814:32 2821:33 2824:54 2834:54 2842:39 2852:99 2863:98 2873:97 2879:94 2881:78 2883:0 2885:0"), 2891.888);
    expect(run).toEqual({ start: 2852, before: 2842 });
  });

  test("finds nothing for a dark scene that isn't the end, a too-short run, or an all-black window", () => {
    expect(CreditsDetector.blackRun(frames("100:10 200:96 210:97 220:96 230:20 280:15 290:10"), 300)).toBeNull();
    expect(CreditsDetector.blackRun(frames("250:10 280:20 292:96 296:97"), 300)).toBeNull();
    expect(CreditsDetector.blackRun(frames("0:99 100:99 200:99 290:99"), 300)).toBeNull();
    expect(CreditsDetector.blackRun([], 300)).toBeNull();
  });

  test("reads ffmpeg's blackframe lines, shifted to the file's timeline", () => {
    const stderr =
      "[Parsed_blackframe_0 @ 0xffff70002030] frame:0 pblack:15 pts:7711 t:7.711000 type:I last_keyframe:0\n" +
      "[Parsed_blackframe_0 @ 0xffff70002030] frame:1 pblack:100 pts:2289 t:2.289000 type:I last_keyframe:1\n";
    expect(CreditsDetector.parseBlackFrames(stderr, 100)).toEqual([
      { percent: 15, seconds: 107.711 },
      { percent: 100, seconds: 102.289 },
    ]);
  });
});

// ---------- From a real file ---------- //

const hasFfmpeg = Bun.which("ffmpeg") !== null;

describe.skipIf(!hasFfmpeg)("CreditsLocator", () => {
  let root: string;
  let server: ReturnType<typeof Bun.serve>;
  let lookups = 0;
  const original = TheIntroDb.baseUrl;
  const items: MediaItem[] = [];

  /** Where the credits of the made-up episode start: between two keyframes, five seconds apart. */
  const CREDITS_S = 41.5;

  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), "findr-credits-"));

    // A 70-second episode: picture, then credits (a white block on black), then a 5-second logo
    const clip = join(root, "clip.mkv");
    const make = Bun.spawnSync([
      "ffmpeg", "-v", "error", "-y",
      "-f", "lavfi", "-i", `testsrc2=size=320x180:rate=24:duration=${CREDITS_S}`,
      "-f", "lavfi", "-i", `color=black:size=320x180:rate=24:duration=${65 - CREDITS_S},drawbox=x=140:y=60:w=40:h=20:color=white:t=fill`,
      "-f", "lavfi", "-i", "testsrc2=size=320x180:rate=24:duration=5",
      "-f", "lavfi", "-i", "sine=frequency=440:duration=70",
      "-filter_complex", "[0:v][1:v][2:v]concat=n=3:v=1:a=0[v]",
      "-map", "[v]", "-map", "3:a",
      "-c:v", "libx264", "-preset", "ultrafast", "-g", "120", "-keyint_min", "120", "-sc_threshold", "0", "-pix_fmt", "yuv420p",
      "-c:a", "aac", "-shortest",
      clip,
    ]);
    if (make.exitCode !== 0) throw new Error(make.stderr.toString());

    // TheIntroDB knows episode 1, has nothing on episode 2, and is down for episode 3
    server = Bun.serve({
      port: 0,
      fetch(request) {
        lookups++;
        const episode = new URL(request.url).searchParams.get("episode");
        if (episode === "1") return Response.json({ credits: [{ start_ms: 60_000, end_ms: null }] });
        if (episode === "2") return Response.json({ error: "no_submissions" }, { status: 404 });
        return new Response("down", { status: 503 });
      },
    });
    TheIntroDb.baseUrl = `http://127.0.0.1:${server.port}`;

    // Three copies of it as episodes of one show
    const title = Title.findOrCreate(424_242, "tv");
    const probe: ProbeInfo = {
      durationMs: 70_000,
      bitrate: 500_000,
      startTime: 0,
      video: { index: 0, codec: "h264", width: 320, height: 180, bitDepth: 8, hdr: false, profile: "High", level: 13, frameRate: 24, transfer: "bt709" },
      audio: [{ index: 1, codec: "aac", channels: 1, language: null, title: null, isDefault: true }],
    };
    for (const episode of [1, 2, 3]) {
      const path = join(root, `e${episode}.mkv`);
      await copyFile(clip, path);
      items.push(MediaItem.upsert({ titleId: title.id, downloadId: null, season: 1, episode, path, size: 1, mtime: 1, probe, keyframes: Float64Array.from([0]) }));
    }
  });

  afterAll(async () => {
    TheIntroDb.baseUrl = original;
    server.stop(true);
    await rm(root, { recursive: true, force: true });
  });

  const fresh = (index: number) => MediaItem.find(items[index]?.id ?? "") as MediaItem;

  test("finds the exact frame the credits start on, between keyframes", async () => {
    const creditsMs = await CreditsDetector.blackFrames(fresh(1));
    expect(creditsMs).not.toBeNull();
    expect(Math.abs((creditsMs ?? 0) - CREDITS_S * 1000)).toBeLessThan(100);
  }, 30_000);

  test("takes TheIntroDB's answer for good", async () => {
    expect(await CreditsLocator.getInstance().creditsOf(fresh(0))).toBe(60_000);
    expect(fresh(0).creditsSource).toBe("theintrodb");
    expect(fresh(0).creditsRetryAt).toBeNull();
  });

  test("reads the file when TheIntroDB has nothing, then answers from the database", async () => {
    const creditsMs = await CreditsLocator.getInstance().creditsOf(fresh(1));
    expect(Math.abs((creditsMs ?? 0) - CREDITS_S * 1000)).toBeLessThan(100);
    expect(fresh(1).creditsSource).toBe("blackframe");
    expect(fresh(1).creditsRetryAt ?? 0).toBeGreaterThan(Date.now() + 6 * 24 * 60 * 60_000);

    const before = lookups;
    expect(await CreditsLocator.getInstance().creditsOf(fresh(1))).toBe(creditsMs);
    expect(lookups).toBe(before);
  }, 30_000);

  test("asks TheIntroDB again within the hour when it couldn't be reached", async () => {
    const creditsMs = await CreditsLocator.getInstance().creditsOf(fresh(2));
    expect(Math.abs((creditsMs ?? 0) - CREDITS_S * 1000)).toBeLessThan(100);
    expect(fresh(2).creditsRetryAt ?? 0).toBeLessThan(Date.now() + 61 * 60_000);
  }, 30_000);

  test("forgets the credits when the file is indexed again", () => {
    const item = fresh(0);
    MediaItem.upsert({ titleId: item.titleId, downloadId: null, season: 1, episode: 1, path: item.path, size: 2, mtime: 2, probe: item.probe, keyframes: item.keyframes });
    expect(fresh(0).creditsSource).toBeNull();
    expect(fresh(0).creditsMs).toBeNull();
  });
});
