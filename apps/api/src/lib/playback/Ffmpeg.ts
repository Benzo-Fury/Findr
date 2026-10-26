/**
 * Runs ffmpeg and ffprobe for playback: whether they are installed and which
 * filters they have, a run-to-completion helper for probing, and the argument
 * lists for each kind of output: fragmented MP4 for HLS, MPEG-TS for DLNA
 * renderers, and sprite sheets of scrubbing thumbnails. Video encoding goes
 * through one builder, so x264 and every hardware encoder take the same
 * scaling, tone mapping and keyframe placement.
 *
 * Library files are always Matroska written by the sterilizer, so every
 * input is opened as Matroska from a local file only (`MediaInput`), never
 * left to ffmpeg to guess.
 *
 * The binaries are found by `FfmpegLocator` (the environment, the copy
 * inside the executable, or `PATH`), never from a setting, so a browser
 * session can't point Findr at another program.
 */

import type { HardwareAcceleration, PlaybackSettings } from "@findr/types/playback";
import { FfmpegLocator } from "../media/FfmpegLocator";
import { MediaInput } from "../media/MediaInput";
import type { PlaybackPlan } from "./PlaybackDecider";

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

/** How an encode should come out, whatever encoder makes it. */
export interface VideoEncode {
  /** Height to scale to, or null to keep the source's. */
  scaleToHeight: number | null;
  /** Video bitrate ceiling, or null for quality-based encoding. */
  bitrateCap: number | null;
  /** The bitrate expected at this height, for encoders that only take a target. */
  bitrateEstimate: number;
  /** Convert HDR to SDR on the way. */
  toneMap: boolean;
  /** Seconds between forced keyframes. */
  keyframeSeconds: number;
}

/** The encoder each hardware acceleration uses for H.264. */
const H264_ENCODERS: Record<HardwareAcceleration, string> = {
  none: "libx264",
  videotoolbox: "h264_videotoolbox",
  nvenc: "h264_nvenc",
  qsv: "h264_qsv",
  vaapi: "h264_vaapi",
  amf: "h264_amf",
  rkmpp: "h264_rkmpp",
};

/**
 * HDR (PQ or HLG) to SDR BT.709: linearise, map the highlights down with
 * Hable's curve, then convert to BT.709 primaries and transfer. zscale does
 * the colour maths; ffmpeg's own scaler can't.
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
    if (!this.canToneMap) console.warn("[Playback] ffmpeg has no zscale filter, so HDR is converted without tone mapping");
    return true;
  }

  /** Whether this ffmpeg can tone map HDR to SDR. */
  public static get canToneMap(): boolean {
    return this.filters !== null && this.filters.has("zscale") && this.filters.has("tonemap");
  }

  /** The H.264 encoder a hardware acceleration setting uses. */
  public static encoderName(acceleration: HardwareAcceleration): string {
    return H264_ENCODERS[acceleration];
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
  public static streamArgs(path: string, plan: PlaybackPlan, startSeconds: number, settings: PlaybackSettings): string[] {
    const args = ["-hide_banner", "-nostdin", "-nostats", "-loglevel", "error"];
    const encode = plan.video === "encode" ? this.videoEncode(settings, this.encodeFor(plan, settings.segmentSeconds)) : null;
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
  public static transportStreamArgs(path: string, plan: PlaybackPlan, startSeconds: number, settings: PlaybackSettings): string[] {
    const args = ["-hide_banner", "-nostdin", "-nostats", "-loglevel", "error"];
    const encode = plan.video === "encode" ? this.videoEncode(settings, this.encodeFor(plan, 2)) : null;
    if (encode) args.push(...encode.input);
    if (startSeconds > 0) args.push("-ss", startSeconds.toFixed(3));
    args.push(...MediaInput.args("matroska", path));
    args.push(...this.mapArgs(plan));
    if (encode) args.push(...encode.output);
    else args.push("-c:v", "copy");
    args.push(...this.audioArgs(plan));
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
    if (options.toneMap && this.canToneMap) filters.push(...TONE_MAP_FILTERS);
    filters.push(`scale=${options.width}:${options.height}`, `tile=${TRICKPLAY_TILE}x${TRICKPLAY_TILE}`);
    return [
      "-hide_banner", "-nostdin", "-nostats", "-loglevel", "error",
      "-skip_frame", "nokey", ...MediaInput.args("matroska", path),
      "-map", `0:${videoStream}`, "-an", "-sn", "-dn",
      "-vf", filters.join(","), "-fps_mode", "passthrough", "-q:v", "5",
      "-f", "image2", "-start_number", "1", `${directory}/%d.jpg`,
    ];
  }

  // ---------- Encoder test ---------- //

  /**
   * Encodes three seconds of a generated test picture with the configured
   * encoder and throws away the result, so an admin can tell whether the
   * hardware encoder works on this machine before anyone presses Play.
   */
  public static async testEncoder(settings: PlaybackSettings): Promise<{ ok: boolean; message: string }> {
    const encode = this.videoEncode(settings, { scaleToHeight: 720, bitrateCap: null, bitrateEstimate: 4_000_000, toneMap: false, keyframeSeconds: 2 });
    const args = ["-hide_banner", "-nostdin", "-nostats", "-loglevel", "error", ...encode.input];
    args.push("-f", "lavfi", "-i", "testsrc2=size=1920x1080:rate=24", "-t", "3", ...encode.output, "-f", "null", "-");

    const started = performance.now();
    const output = await this.run(FfmpegLocator.path("ffmpeg"), args, AbortSignal.timeout(30_000));
    const seconds = ((performance.now() - started) / 1000).toFixed(1);
    if (output.exitCode === 0) return { ok: true, message: `Encoded 3 seconds of 1080p to 720p in ${seconds} s` };
    return { ok: false, message: output.stderr.trim().split("\n").slice(-3).join(" ") || `ffmpeg exited with ${output.exitCode}` };
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

  /** What a plan asks of the video encoder. */
  private static encodeFor(plan: PlaybackPlan, keyframeSeconds: number): VideoEncode {
    return {
      scaleToHeight: plan.scaleToHeight,
      bitrateCap: plan.videoBitrateCap,
      bitrateEstimate: Math.max(plan.bitrate - (plan.audio === "encode" ? AUDIO_BITRATE : 0), 500_000),
      toneMap: plan.toneMap,
      keyframeSeconds,
    };
  }

  /**
   * H.264 encoding with the configured encoder: arguments that go before the
   * input (a hardware device) and after it (filters, encoder and its rate
   * control). Every encoder gets a keyframe every `keyframeSeconds` counted
   * from the start of the run, and no B-frames, so presentation and decode
   * times agree and segments cut cleanly.
   */
  public static videoEncode(settings: PlaybackSettings, encode: VideoEncode): { input: string[]; output: string[] } {
    const acceleration = settings.hardwareAcceleration;
    const crf = String(settings.h264Crf);
    const cap = encode.bitrateCap;
    const input: string[] = [];
    const output: string[] = ["-c:v", H264_ENCODERS[acceleration]];

    // Filters run on the CPU: tone map, scale, then hand frames over in the encoder's format
    const filters: string[] = [];
    if (encode.toneMap && this.canToneMap) filters.push(...TONE_MAP_FILTERS);
    if (encode.scaleToHeight !== null) filters.push(`scale=-2:${encode.scaleToHeight}`);
    if (acceleration === "vaapi") {
      input.push("-vaapi_device", settings.vaapiDevice);
      filters.push("format=nv12", "hwupload");
    } else filters.push(acceleration === "qsv" ? "format=nv12" : "format=yuv420p");
    output.push("-vf", filters.join(","));

    // Rate control: quality-based unless capped, in each encoder's own terms
    const capped = cap === null ? [] : ["-maxrate", String(cap), "-bufsize", String(cap * 2)];
    switch (acceleration) {
      case "none":
        output.push("-preset", settings.encoderPreset, "-profile:v", "high", "-crf", crf, ...capped);
        break;
      case "videotoolbox":
        output.push("-profile:v", "high", "-allow_sw", "1", "-b:v", String(cap ?? encode.bitrateEstimate));
        break;
      case "nvenc":
        output.push("-preset", "p4", "-profile:v", "high", "-rc", "vbr", "-cq", crf, "-b:v", "0", ...capped, "-forced-idr", "1");
        break;
      case "qsv":
        output.push("-preset", "veryfast", "-profile:v", "high", "-look_ahead", "0", "-forced_idr", "1");
        output.push(...(cap === null ? ["-global_quality", crf] : ["-b:v", String(cap), ...capped]));
        break;
      case "vaapi":
        output.push(...(cap === null ? ["-rc_mode", "CQP", "-qp", crf] : ["-rc_mode", "VBR", "-b:v", String(cap), ...capped]));
        break;
      case "amf":
        output.push("-quality", "speed", ...(cap === null ? ["-rc", "cqp", "-qp_i", crf, "-qp_p", crf] : ["-rc", "vbr_peak", "-b:v", String(cap), ...capped]));
        break;
      case "rkmpp":
        output.push(...(cap === null ? ["-rc_mode", "CQP", "-qp_init", crf] : ["-rc_mode", "VBR", "-b:v", String(cap), ...capped]));
        break;
    }

    output.push("-bf", "0", "-force_key_frames", `expr:gte(t,n_forced*${encode.keyframeSeconds})`, "-sc_threshold", "0");
    if (acceleration === "none" && settings.threads > 0) output.push("-threads", String(settings.threads));
    return { input, output };
  }
}
