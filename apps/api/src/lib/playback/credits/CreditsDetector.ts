/**
 * Finds where an episode's end credits start from the file itself, for
 * episodes TheIntroDB doesn't cover. Only the last few minutes are read.
 *
 * Two ways, tried in order:
 *
 * - **Audio fingerprints.** Chromaprint turns the ending's audio into a
 *   fingerprint, about eight 32-bit points a second. Shows that close every
 *   episode on the same theme share a long run of near-identical points with
 *   their neighbours; where that run starts is where the credits start. This
 *   needs an ffmpeg built with Chromaprint (Findr's embedded jellyfin-ffmpeg
 *   on Linux is), and is skipped without one.
 * - **Black frames.** Credits are mostly text on black. Keyframes alone are
 *   scanned first, cheaply, for a run of black pictures that lasts to the end
 *   of the file (bar a closing logo); then every frame between the last
 *   picture before that run and its first keyframe, to find the exact frame.
 *
 * The thresholds were tuned on real episodes (Breaking Bad, whose credits
 * play over a different song each episode, so only black frames find them).
 */

import type { MediaItem } from "../../db/models/MediaItem";
import { FfmpegLocator } from "../../media/FfmpegLocator";
import { type ContainerFormat, MediaInput } from "../../media/MediaInput";

// ---------- Tuning ---------- //

/** How much of each ending is read, in seconds. */
const WINDOW_SECONDS = 300;

/** Seconds of audio each fingerprint point covers (Chromaprint's default: 4096-sample frames, 2/3 overlap, at 11025 Hz). */
export const POINT_SECONDS = 0.1238;

/** Points match when they differ in at most this many of their 32 bits. */
const MAX_POINT_BITS = 6;

/** A run of matching points survives gaps up to this long. */
const MAX_GAP_SECONDS = 3.5;

/** The shortest shared run that counts as credits; shorter ones are a studio logo's sting. */
const MIN_MATCH_SECONDS = 15;

/** Credits, found either way, must last to within this of the end of the file; what follows is a logo. */
const END_SLACK_SECONDS = 60;

/** A picture counts as black when this percentage of its pixels is. */
const BLACK_PERCENT = 85;

/** A pixel counts as black below this luma (of 255). */
const BLACK_LUMA = 32;

/** The shortest run of black keyframes that counts as credits. */
const MIN_BLACK_SECONDS = 10;

// ---------- Results ---------- //

/** Where a shared run of audio starts in each of two fingerprints, and how long it lasts, in points. */
export interface FingerprintMatch {
  a: number;
  b: number;
  points: number;
}

/** One picture's share of black pixels, by its time in seconds. */
export interface BlackFrame {
  seconds: number;
  percent: number;
}

/** A run of black keyframes: its first keyframe, and the picture before it (the run's start lies between). */
export interface BlackRun {
  start: number;
  before: number;
}

// ---------- Detector ---------- //

export class CreditsDetector {
  /** Whether the ffmpeg in use can make fingerprints, by its path; asked once each. */
  private static chromaprint = new Map<string, Promise<boolean>>();

  /** Where the scanned window starts in a file, in seconds. */
  public static windowStart(item: MediaItem): number {
    return Math.max(0, item.durationMs / 1000 - WINDOW_SECONDS);
  }

  // ---------- Fingerprints ---------- //

  /** Whether ffmpeg was built with Chromaprint. */
  public static supportsFingerprints(): Promise<boolean> {
    const binary = FfmpegLocator.path("ffmpeg");
    let known = this.chromaprint.get(binary);
    if (!known) {
      known = this.spawn(["-hide_banner", "-muxers"])
        .then((output) => /\bchromaprint\b/.test(new TextDecoder().decode(output.stdout)))
        .catch(() => false);
      this.chromaprint.set(binary, known);
    }
    return known;
  }

  /** The fingerprint of an episode's ending, from its default audio track; null when there is none to make. */
  public static async fingerprint(item: MediaItem, signal?: AbortSignal): Promise<Uint32Array | null> {
    const audio = item.defaultAudioStream;
    if (audio === null || !(await this.supportsFingerprints())) return null;
    const format = await MediaInput.sniff(item.path);
    if (!format) return null;

    // Raw points are little-endian 32-bit words on stdout
    const output = await this.spawn(
      [
        "-hide_banner", "-v", "error",
        "-ss", this.windowStart(item).toFixed(3),
        ...MediaInput.args(format, item.path),
        "-map", `0:${audio}`, "-vn", "-sn", "-dn", "-ac", "1", "-t", String(WINDOW_SECONDS),
        "-f", "chromaprint", "-fp_format", "raw", "pipe:1",
      ],
      signal,
    );
    if (output.exitCode !== 0 || output.stdout.byteLength < 4) return null;
    const bytes = output.stdout;
    const points = new Uint32Array(Math.floor(bytes.byteLength / 4));
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    for (let index = 0; index < points.length; index++) points[index] = view.getUint32(index * 4, true);
    return points;
  }

  /**
   * The longest run of near-identical points two fingerprints share, at any
   * offset between them, when it is long enough to be credits and lasts to
   * near the end of either; else null. Only one need reach the end, as an
   * episode may follow its credits with a scene the other doesn't have.
   */
  public static match(a: Uint32Array, b: Uint32Array): FingerprintMatch | null {
    const gap = Math.round(MAX_GAP_SECONDS / POINT_SECONDS);
    let best: FingerprintMatch = { a: 0, b: 0, points: 0 };

    // Every alignment of b against a, tracking runs of matching points along it
    for (let shift = -(a.length - 1); shift < b.length; shift++) {
      let runStart = -1;
      let last = -1;
      for (let i = Math.max(0, -shift); i < a.length && i + shift < b.length; i++) {
        if (this.bits((a[i] ?? 0) ^ (b[i + shift] ?? 0)) > MAX_POINT_BITS) continue;
        if (runStart < 0 || i - last > gap) runStart = i;
        last = i;
        const points = last - runStart + 1;
        if (points > best.points) best = { a: runStart, b: runStart + shift, points };
      }
    }

    // Long enough, and reaching the end of at least one ending (the other may go on to a scene after the credits)
    const slack = END_SLACK_SECONDS / POINT_SECONDS;
    if (best.points * POINT_SECONDS < MIN_MATCH_SECONDS) return null;
    if (best.a + best.points < a.length - slack && best.b + best.points < b.length - slack) return null;
    return best;
  }

  // ---------- Black frames ---------- //

  /** Where the credits start by black frames, in milliseconds from the start of the file, or null. */
  public static async blackFrames(item: MediaItem, signal?: AbortSignal): Promise<number | null> {
    const format = await MediaInput.sniff(item.path);
    if (!format) return null;
    const windowStart = this.windowStart(item);

    // Keyframes only, for the run
    const coarse = await this.scanBlack(format, item, windowStart, null, 0, true, signal);
    const run = this.blackRun(coarse, item.durationMs / 1000);
    if (!run) return null;

    // Every frame from the picture before the run to its first keyframe, for the first black one
    const fine = await this.scanBlack(format, item, run.before, run.start - run.before + 0.5, BLACK_PERCENT, false, signal);
    const first = fine.find((frame) => frame.percent >= BLACK_PERCENT && frame.seconds <= run.start + 0.25);
    return Math.round((first?.seconds ?? run.start) * 1000);
  }

  /**
   * The run of black keyframes that lasts to the end: walking back from the
   * end past a closing logo, then over consecutive black keyframes. Null when
   * there is none long enough, or it reaches back to the window's first
   * keyframe, so where it starts can't be told.
   */
  public static blackRun(frames: BlackFrame[], durationSeconds: number): BlackRun | null {
    const sorted = [...frames].sort((x, y) => x.seconds - y.seconds);
    let index = sorted.length - 1;

    // Skip the closing logo, which must be short
    while (index >= 0 && (sorted[index]?.percent ?? 0) < BLACK_PERCENT) {
      if ((sorted[index]?.seconds ?? 0) < durationSeconds - END_SLACK_SECONDS) return null;
      index--;
    }
    if (index < 0) return null;
    const last = sorted[index]?.seconds ?? 0;
    if (last < durationSeconds - END_SLACK_SECONDS) return null;

    // Back over the black keyframes
    while (index > 0 && (sorted[index - 1]?.percent ?? 0) >= BLACK_PERCENT) index--;
    const start = sorted[index]?.seconds ?? 0;
    if (index === 0 || last - start < MIN_BLACK_SECONDS) return null;
    return { start, before: sorted[index - 1]?.seconds ?? start };
  }

  /** Reads `blackframe` lines (`pblack:N … t:S`) into pictures, their times moved by `offset` seconds. */
  public static parseBlackFrames(stderr: string, offset: number): BlackFrame[] {
    return [...stderr.matchAll(/pblack:(\d+)\b.*?\bt:(-?[\d.]+)/g)].map((match) => ({
      percent: Number(match[1]),
      seconds: Number(match[2]) + offset,
    }));
  }

  /**
   * Runs `blackframe` over part of a file: from `start` for `length` seconds
   * (to the end when null), on keyframes only or every frame, logging
   * pictures at least `minPercent` black.
   */
  private static async scanBlack(
    format: ContainerFormat,
    item: MediaItem,
    start: number,
    length: number | null,
    minPercent: number,
    keyframesOnly: boolean,
    signal?: AbortSignal,
  ): Promise<BlackFrame[]> {
    const output = await this.spawn(
      [
        "-hide_banner", "-nostats",
        ...(keyframesOnly ? ["-skip_frame", "nokey"] : []),
        "-ss", start.toFixed(3),
        ...(length !== null ? ["-t", length.toFixed(3)] : []),
        ...MediaInput.args(format, item.path),
        "-map", `0:${item.probe.video.index}`, "-an", "-sn", "-dn",
        "-vf", `blackframe=amount=${minPercent}:threshold=${BLACK_LUMA}`,
        "-f", "null", "-",
      ],
      signal,
    );
    // An input seek restarts timestamps at the seek point
    return this.parseBlackFrames(new TextDecoder().decode(output.stderr), start);
  }

  // ---------- Helpers ---------- //

  /** How many bits are set in a 32-bit word. */
  private static bits(value: number): number {
    let x = value - ((value >>> 1) & 0x55555555);
    x = (x & 0x33333333) + ((x >>> 2) & 0x33333333);
    return (((x + (x >>> 4)) & 0x0f0f0f0f) * 0x01010101) >>> 24;
  }

  /** Runs ffmpeg, keeping stdout as bytes; stopped with `signal`. */
  private static async spawn(args: string[], signal?: AbortSignal): Promise<{ exitCode: number; stdout: Uint8Array; stderr: Uint8Array }> {
    const child = Bun.spawn([FfmpegLocator.path("ffmpeg"), ...args], { stdin: "ignore", stdout: "pipe", stderr: "pipe" });
    const onAbort = () => child.kill();
    signal?.addEventListener("abort", onAbort, { once: true });
    try {
      // Drain both pipes together so neither fills and blocks the process
      const [stdout, stderr, exitCode] = await Promise.all([
        new Response(child.stdout).bytes(),
        new Response(child.stderr).bytes(),
        child.exited,
      ]);
      return { exitCode, stdout, stderr };
    } finally {
      signal?.removeEventListener("abort", onAbort);
    }
  }
}
