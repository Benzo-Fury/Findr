/**
 * Runs ffmpeg and ffprobe for playback: whether they are installed and which
 * filters they have, a run-to-completion helper for probing, and the argument
 * lists for each kind of output: fragmented MP4 for HLS, MPEG-TS for DLNA
 * renderers, and sprite sheets of scrubbing thumbnails. Re-encoded video
 * comes from `TranscodePipeline`, by way of the session's `TranscodeLadder`,
 * so x264 and every hardware rung take the same scaling, tone mapping and
 * keyframe placement.
 *
 * Library files are always Matroska written by the sterilizer, so every
 * input is opened as Matroska from a local file only (`MediaInput`), never
 * left to ffmpeg to guess.
 *
 * The binaries are found by `FfmpegLocator` (the environment, the copy
 * inside the executable, or `PATH`), never from a setting, so a browser
 * session can't point Findr at another program.
 */

import type { PlaybackSettings } from "@findr/types/playback";
import { FfmpegLocator } from "../media/FfmpegLocator";
import { MediaInput } from "../media/MediaInput";
import type { PlaybackPlan } from "./PlaybackDecider";
import type { VideoArgs } from "./TranscodePipeline";

/** What a finished process printed and how it exited. */
export interface ProcessOutput {
  exitCode: number;
  stdout: string;
  stderr: string;
}

/** Thrown when ffmpeg or ffprobe can't be started at all. */
export class FfmpegMissingError extends Error {
  constructor(binary: string) {
    super(`${binary} is not available`);
    this.name = "FfmpegMissingError";
  }
}

/** Audio bitrate of a converted track, in bits per second. */
export const AUDIO_BITRATE = 192_000;

/**
 * HDR (PQ or HLG) to SDR BT.709 for thumbnails when ffmpeg lacks `tonemapx`:
 * linearise, map the highlights down with Hable's curve, then convert to
 * BT.709 primaries and transfer. zscale does the colour maths; ffmpeg's own
 * scaler can't.
 */
const TONE_MAP_FILTERS = [
  "zscale=t=linear:npl=100",
  "format=gbrpf32le",
  "zscale=p=bt709",
  "tonemap=tonemap=hable:desat=0",
  "zscale=t=bt709:m=bt709:r=tv",
];

/** Scrubbing thumbnails per sprite sheet, as columns and rows. */
export const TRICKPLAY_TILE = 10;

export class Ffmpeg {
  /** ffmpeg's filter names, read once after it is found; null until then. */
  private static filters: Set<string> | null = null;

  /** Whether ffmpeg and ffprobe are installed (`FfmpegLocator`), and which filters ffmpeg has. */
  public static async available(): Promise<boolean> {
    // The locator logs a missing binary itself, once
    if (!(await FfmpegLocator.available())) return false;
    if (this.filters) return true;

    // Lines read like ` .S tonemap   V->V   Conversion…`
    const filters = new Set<string>();
    const listed = await this.run(FfmpegLocator.path("ffmpeg"), ["-hide_banner", "-filters"]).catch(() => null);
    for (const line of listed?.stdout.split("\n") ?? []) {
      const name = /^\s*\S+\s+(\w+)\s/.exec(line)?.[1];
      if (name) filters.add(name);
    }
    this.filters = filters;
    if (!this.canToneMap) console.warn("[Playback] ffmpeg has neither tonemapx nor zscale, so HDR is converted without tone mapping");
    return true;
  }

  /** Whether this ffmpeg can tone map HDR to SDR, with `tonemapx` or zscale. */
  public static get canToneMap(): boolean {
    return this.filters !== null && (this.filters.has("tonemapx") || (this.filters.has("zscale") && this.filters.has("tonemap")));
  }

  /** ffmpeg's filter names, once `available()` has read them; empty before. */
  public static get filterNames(): ReadonlySet<string> {
    return this.filters ?? new Set();
  }

  /**
   * Runs a binary to completion and collects its output. Kills it when the
   * signal aborts, and throws `FfmpegMissingError` when it can't start.
   */
  public static async run(binary: string, args: string[], signal?: AbortSignal): Promise<ProcessOutput> {
    let child: ReturnType<typeof Bun.spawn<"ignore", "pipe", "pipe">>;
    try {
      child = Bun.spawn([binary, ...args], { stdin: "ignore", stdout: "pipe", stderr: "pipe" });
    } catch {
      throw new FfmpegMissingError(binary);
    }

    // Stop the process with the caller
    const onAbort = () => child.kill();
    signal?.addEventListener("abort", onAbort, { once: true });

    // Drain both pipes together so neither fills and blocks the process
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    signal?.removeEventListener("abort", onAbort);
    return { exitCode, stdout, stderr };
  }

  // ---------- HLS ---------- //

  /**
   * The ffmpeg arguments that stream `path` from `startSeconds` as
   * fragmented MP4 on stdout, one fragment per video keyframe. Only the
   * chosen video and audio streams are mapped; everything else in the file
   * — and its metadata and chapters — is left behind.
   */
  public static streamArgs(path: string, plan: PlaybackPlan, startSeconds: number, video: VideoArgs | null): string[] {
    const args = ["-hide_banner", "-nostdin", "-nostats", "-loglevel", "error"];
    const encode = plan.video === "encode" ? video : null;
    if (plan.video === "encode" && !video) throw new Error("A transcode needs its video arguments");
    if (encode) args.push(...encode.input);

    // Keep the file's own timestamps so every run shares one timeline. Copying can
    // only start on a keyframe and lands on an earlier one than asked, so audio is
    // decoded from that same spot and the fragments before the segment are dropped
    const start = startSeconds.toFixed(3);
    if (plan.video === "copy") args.push("-noaccurate_seek");
    args.push("-copyts");
    if (startSeconds > 0) args.push("-ss", start);
    args.push(...MediaInput.args("matroska", path));
    args.push(...this.mapArgs(plan));

    // Video: copied as it is, or re-encoded to H.264 with keyframes on every segment boundary
    if (encode) args.push(...encode.output);
    else {
      args.push("-c:v", "copy");
      if (plan.sourceVideoCodec === "hevc") args.push("-tag:v", "hvc1");
    }
    args.push(...this.audioArgs(plan));

    // Fragmented MP4 on stdout, a fragment starting at every video keyframe, with
    // decode times taken from the input rather than restarted at zero. No edit
    // list, so every run's init section means the same; B-frame reordering is
    // carried by negative composition offsets instead. The header waits for the
    // first packets, which copied AC-3 needs to describe itself
    args.push("-max_muxing_queue_size", "4096", "-use_editlist", "0");
    args.push("-f", "mp4", "-movflags", "frag_keyframe+empty_moov+delay_moov+default_base_moof+negative_cts_offsets+frag_discont", "pipe:1");
    return args;
  }

  // ---------- MPEG-TS ---------- //

  /**
   * The ffmpeg arguments that stream `path` from `startSeconds` as one
   * MPEG-TS on stdout, for DLNA renderers that won't take the file as it is.
   * Timestamps restart at zero; the renderer is told where the stream began.
   */
  public static transportStreamArgs(path: string, plan: PlaybackPlan, startSeconds: number, video: VideoArgs | null): string[] {
    const args = ["-hide_banner", "-nostdin", "-nostats", "-loglevel", "error"];
    const encode = plan.video === "encode" ? video : null;
    if (plan.video === "encode" && !video) throw new Error("A transcode needs its video arguments");
    if (encode) args.push(...encode.input);
    if (startSeconds > 0) args.push("-ss", startSeconds.toFixed(3));
    args.push(...MediaInput.args("matroska", path));
    args.push(...this.mapArgs(plan));
    if (encode) args.push(...encode.output);
    else args.push("-c:v", "copy");
    args.push(...this.audioArgs(plan));

    // A seek lands on the keyframe before `startSeconds`: re-encoded video is trimmed to the
    // exact second, but copied audio keeps that lead-in and would play ahead of the picture
    // on TVs that start both streams together. Drop the audio before the start to match
    if (startSeconds > 0 && encode && plan.audio === "copy") args.push("-ss", "0");
    args.push("-max_muxing_queue_size", "4096", "-f", "mpegts", "-muxdelay", "0", "pipe:1");
    return args;
  }

  // ---------- Thumbnails ---------- //

  /**
   * The ffmpeg arguments that write scrubbing thumbnails for a file as JPEG
   * sprite sheets (`1.jpg`, `2.jpg`, …), one thumbnail every
   * `intervalSeconds`, `TRICKPLAY_TILE` by `TRICKPLAY_TILE` to a sheet. Only
   * keyframes are decoded, which is many times faster and close enough for
   * a preview.
   */
  public static trickplayArgs(path: string, videoStream: number, directory: string, options: { intervalSeconds: number; width: number; height: number; toneMap: boolean }): string[] {
    const filters = [`fps=1/${options.intervalSeconds}`];
    if (options.toneMap && this.filters?.has("tonemapx")) {
      filters.push(`scale=${options.width}:${options.height}`, "tonemapx=tonemap=bt2390:t=bt709:m=bt709:p=bt709:format=yuv420p");
    } else {
      if (options.toneMap && this.canToneMap) filters.push(...TONE_MAP_FILTERS);
      filters.push(`scale=${options.width}:${options.height}`);
    }
    filters.push(`tile=${TRICKPLAY_TILE}x${TRICKPLAY_TILE}`);
    return [
      "-hide_banner", "-nostdin", "-nostats", "-loglevel", "error",
      "-skip_frame", "nokey", ...MediaInput.args("matroska", path),
      "-map", `0:${videoStream}`, "-an", "-sn", "-dn",
      "-vf", filters.join(","), "-fps_mode", "passthrough", "-q:v", "5",
      "-f", "image2", "-start_number", "1", `${directory}/%d.jpg`,
    ];
  }

  // ---------- Building blocks ---------- //

  /** Exactly one video and one audio stream, nothing else. */
  private static mapArgs(plan: PlaybackPlan): string[] {
    return ["-map", `0:${plan.videoStream}`, "-map", `0:${plan.audioStream}`, "-sn", "-dn", "-map_metadata", "-1", "-map_chapters", "-1"];
  }

  /** Audio copied when the device takes it, otherwise stereo AAC. */
  private static audioArgs(plan: PlaybackPlan): string[] {
    return plan.audio === "copy" ? ["-c:a", "copy"] : ["-c:a", "aac", "-ac", "2", "-b:a", String(AUDIO_BITRATE)];
  }
}
