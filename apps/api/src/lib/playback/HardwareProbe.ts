/**
 * Finds out what the hardware on this machine does for transcoding, and
 * where each transcode should start on the ladder `TranscodePipeline` builds.
 *
 * For the configured API, or for each one `auto` may pick on this platform
 * until one works, it checks with ffmpeg: that the encoder encodes; which
 * video kinds the decoder decodes with frames left on the device (proved by
 * downloading them); and whether the device scales and tone maps. The test
 * clips are made once, tiny, with ffmpeg's CPU encoders. The answer is kept
 * until the settings change or an admin tests again.
 *
 * A transcode starts on the highest rung those checks allow. A run that fails
 * before producing anything steps down a rung (`TranscodeLadder.stepDown`),
 * and the failure is remembered for that kind of transcode, so the next one
 * starts lower. Remembered failures are forgotten with the answer.
 */

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DecodeKind, HardwareAcceleration, HardwareApi, HardwareReport, PlaybackSettings } from "@findr/types/playback";
import { FfmpegLocator } from "../media/FfmpegLocator";
import { MediaInput } from "../media/MediaInput";
import SelfManagedSingleton from "../other/SelfManagedSingleton";
import { AUDIO_BITRATE, Ffmpeg } from "./Ffmpeg";
import type { PlaybackPlan } from "./PlaybackDecider";
import type { ProbeInfo } from "./MediaProbe";
import { RUNGS, type Rung, type TranscodeSource, TranscodePipeline, type VideoArgs, type VideoEncode } from "./TranscodePipeline";

// ---------- Types ---------- //

/** A test clip for one decode kind. */
interface Clip {
  kind: DecodeKind;
  path: string;
  tenBit: boolean;
}

/** How each decode kind's clip is made with ffmpeg's CPU encoders. */
const CLIP_RECIPES: Array<{ kind: DecodeKind; encoder: string; pixelFormat: string; extra: string[] }> = [
  { kind: "h264", encoder: "libx264", pixelFormat: "yuv420p", extra: ["-preset", "ultrafast"] },
  { kind: "hevc", encoder: "libx265", pixelFormat: "yuv420p", extra: ["-preset", "ultrafast", "-x265-params", "log-level=error"] },
  { kind: "hevc10", encoder: "libx265", pixelFormat: "yuv420p10le", extra: ["-preset", "ultrafast", "-x265-params", "log-level=error"] },
  { kind: "av1", encoder: "libsvtav1", pixelFormat: "yuv420p", extra: ["-preset", "12"] },
  { kind: "av1_10", encoder: "libsvtav1", pixelFormat: "yuv420p10le", extra: ["-preset", "12"] },
  { kind: "vp9", encoder: "libvpx-vp9", pixelFormat: "yuv420p", extra: ["-deadline", "realtime", "-cpu-used", "8"] },
  { kind: "vp9_10", encoder: "libvpx-vp9", pixelFormat: "yuv420p10le", extra: ["-deadline", "realtime", "-cpu-used", "8", "-profile:v", "2"] },
];

/** The clips' size: small, but above every hardware decoder's minimum. */
const CLIP_WIDTH = 640;
const CLIP_HEIGHT = 360;

/** What `runOnDevice` answers for a chain the API can't build at all, which isn't a failure to report. */
const NOT_BUILT = "not built";

/** How long one check may take. */
const CHECK_TIMEOUT_MS = 15_000;

/** The APIs `auto` tries on each platform, most capable first. */
function candidates(): HardwareApi[] {
  if (process.platform === "darwin") return ["videotoolbox"];
  if (process.platform === "win32") return ["nvenc", "qsv", "amf"];
  if (process.platform === "linux") return process.arch === "arm64" ? ["rkmpp", "nvenc"] : ["qsv", "vaapi", "nvenc"];
  return [];
}

/** The decode kind of a file's video, or null for one no hardware decoder is asked to take. */
export function decodeKind(codec: string, bitDepth: number): DecodeKind | null {
  if (bitDepth > 10) return null;
  const tenBit = bitDepth > 8;
  switch (codec) {
    case "h264":
      return tenBit ? null : "h264";
    case "hevc":
      return tenBit ? "hevc10" : "hevc";
    case "av1":
      return tenBit ? "av1_10" : "av1";
    case "vp9":
      return tenBit ? "vp9_10" : "vp9";
    default:
      return null;
  }
}

// ---------- Probe ---------- //

export default class HardwareProbe extends SelfManagedSingleton {
  /** The answer for the current settings, by what it depends on. */
  private cached: { key: string; report: Promise<HardwareReport> } | null = null;
  /** Rungs that failed for each kind of transcode, by `TranscodeLadder.key`. */
  private readonly failures = new Map<string, Set<Rung>>();

  /** What the hardware does under these settings, checked once and kept. */
  public report(settings: PlaybackSettings, refresh = false): Promise<HardwareReport> {
    const key = `${settings.hardwareAcceleration}|${settings.vaapiDevice}|${FfmpegLocator.path("ffmpeg")}`;
    if (refresh || this.cached?.key !== key) {
      this.failures.clear();
      this.cached = { key, report: this.check(settings) };
    }
    return this.cached.report;
  }

  /** Forgets the answer and every remembered failure, as when the settings change. */
  public forget(): void {
    this.cached = null;
    this.failures.clear();
  }

  /**
   * A ladder for one transcode, starting on the highest rung the hardware
   * was found to manage for it, below any that failed for its kind before.
   */
  public async ladder(plan: PlaybackPlan, probe: ProbeInfo, settings: PlaybackSettings): Promise<TranscodeLadder> {
    const report = await this.report(settings);
    const source: TranscodeSource = { width: probe.video.width, height: probe.video.height, bitDepth: probe.video.bitDepth };
    return new TranscodeLadder(this, report, plan, source, settings, decodeKind(probe.video.codec, probe.video.bitDepth));
  }

  /** Remembers that a rung failed for a kind of transcode. */
  public recordFailure(key: string, rung: Rung): void {
    const failed = this.failures.get(key) ?? new Set<Rung>();
    failed.add(rung);
    this.failures.set(key, failed);
  }

  /** Every kind of transcode that has stepped down, with the rungs that failed for it, keyed as `TranscodeLadder.key`. */
  public fallbacks(): Array<{ key: string; rungs: Rung[] }> {
    return [...this.failures].map(([key, rungs]) => ({ key, rungs: RUNGS.filter((rung) => rungs.has(rung)) }));
  }

  /** Rungs that failed before for a kind of transcode. */
  public failed(key: string): ReadonlySet<Rung> {
    return this.failures.get(key) ?? new Set();
  }

  // ---------- Checks ---------- //

  /** Checks the configured API, or for `auto` each candidate until one encodes. */
  private async check(settings: PlaybackSettings): Promise<HardwareReport> {
    const started = performance.now();
    const configured: HardwareAcceleration = settings.hardwareAcceleration;
    const none: Omit<HardwareReport, "durationMs"> = { configured, api: "none", encoder: "libx264", encodes: true, decodes: [], scales: false, toneMaps: false, message: null };
    if (configured === "none" || !(await Ffmpeg.available())) return { ...none, durationMs: 0 };

    // The test clips are made once an encoder works, shared by every API tried, and deleted with the check
    const apis = configured === "auto" ? candidates() : [configured];
    const made: { clips?: Promise<{ directory: string; clips: Clip[] }> } = {};
    const clips = () => (made.clips ??= this.makeClips());
    let last: Omit<HardwareReport, "durationMs"> | null = null;
    try {
      for (const api of apis) {
        const report = await this.checkApi(api, configured, settings, clips);
        if (report.encodes) {
          console.info(`[Playback] ${api} ${describe(report)}`);
          return { ...report, durationMs: Math.round(performance.now() - started) };
        }
        last = report;
      }
    } finally {
      if (made.clips) await rm((await made.clips).directory, { recursive: true, force: true }).catch(() => {});
    }

    // Nothing worked: transcodes run on the CPU, and the configured API's complaint is kept for the admin
    if (last) console.warn(`[Playback] No hardware encoder works (${last.message ?? "unknown"}); transcoding on the CPU`);
    return { ...none, message: last?.message ?? null, durationMs: Math.round(performance.now() - started) };
  }

  /** Checks one API: its encoder first, then its decoders and filters. */
  private async checkApi(
    api: HardwareApi,
    configured: HardwareAcceleration,
    settings: PlaybackSettings,
    makeClips: () => Promise<{ clips: Clip[] }>,
  ): Promise<Omit<HardwareReport, "durationMs">> {
    const encoder = TranscodePipeline.encoderName(api);
    const report: Omit<HardwareReport, "durationMs"> = { configured, api, encoder, encodes: false, decodes: [], scales: false, toneMaps: false, message: null };

    // The encoder, on a generated picture filtered on the CPU
    const encode: VideoEncode = { scaleToHeight: 360, bitrateCap: null, bitrateEstimate: 2_000_000, toneMap: false, keyframeSeconds: 2 };
    const encodeArgs = TranscodePipeline.build(api, "encode", encode, { width: 1280, height: 720, bitDepth: 8 }, settings, Ffmpeg.filterNames);
    const encoded = await this.run([...encodeArgs.input, "-f", "lavfi", "-i", "testsrc2=size=1280x720:rate=24", "-frames:v", "12", ...encodeArgs.output, "-f", "null", "-"]);
    if (encoded !== null) return { ...report, message: encoded };
    report.encodes = true;

    // Each decode kind, downloading its frames to prove they were on the device
    const { clips } = await makeClips();
    for (const clip of clips) {
      const check = TranscodePipeline.decodeCheck(api, clip.tenBit, settings);
      if (!check) continue;
      const failure = await this.run([...check.input, ...MediaInput.args("matroska", clip.path), ...(check.filters.length > 0 ? ["-vf", check.filters.join(",")] : []), "-f", "null", "-"]);
      if (failure === null) report.decodes.push(clip.kind);
      else report.message ??= `${clip.kind}: ${failure}`;
    }

    // Scaling and tone mapping on the device, as a real transcode would run them
    const sdr = clips.find((clip) => clip.kind === "hevc" && report.decodes.includes("hevc")) ?? clips.find((clip) => clip.kind === "h264" && report.decodes.includes("h264"));
    if (sdr) {
      const failure = await this.runOnDevice(api, sdr, { ...encode, scaleToHeight: 180 }, settings);
      report.scales = failure === null;
      if (failure !== null && failure !== NOT_BUILT) report.message ??= `scaling: ${failure}`;
    }
    const hdr = clips.find((clip) => clip.kind === "hevc10" && report.decodes.includes("hevc10"));
    if (hdr && report.scales) {
      const failure = await this.runOnDevice(api, hdr, { ...encode, scaleToHeight: 180, toneMap: true }, settings);
      report.toneMaps = failure === null;
      if (failure !== null && failure !== NOT_BUILT) report.message ??= `tone mapping: ${failure}`;
    }
    return report;
  }

  /** Runs the `device` rung on a clip: null when it worked, `NOT_BUILT` when the API has no such chain, else ffmpeg's complaint. */
  private async runOnDevice(api: HardwareApi, clip: Clip, encode: VideoEncode, settings: PlaybackSettings): Promise<string | null> {
    const source: TranscodeSource = { width: CLIP_WIDTH, height: CLIP_HEIGHT, bitDepth: clip.tenBit ? 10 : 8 };
    const args = TranscodePipeline.build(api, "device", encode, source, settings, Ffmpeg.filterNames);
    if (args.rung !== "device") return NOT_BUILT;
    return this.run([...args.input, ...MediaInput.args("matroska", clip.path), ...args.output, "-f", "null", "-"]);
  }

  /** Runs ffmpeg; null when it succeeded, else the first lines of its complaint. */
  private async run(args: string[]): Promise<string | null> {
    const output = await Ffmpeg.run(FfmpegLocator.path("ffmpeg"), ["-hide_banner", "-nostdin", "-nostats", "-loglevel", "error", ...args], AbortSignal.timeout(CHECK_TIMEOUT_MS)).catch(
      (error: unknown) => ({ exitCode: -1, stdout: "", stderr: error instanceof Error ? error.message : String(error) }),
    );
    if (output.exitCode === 0) return null;
    // `[h264_vaapi @ 0x…]` prefixes are dropped; the first lines name the cause
    const lines = output.stderr.trim().split("\n").slice(0, 2).map((line) => line.replace(/^(\[[^\]]*\]\s*)+/, ""));
    return lines.join(" ").trim() || `ffmpeg exited with ${output.exitCode}`;
  }

  /** Makes the test clips in a new directory, leaving out kinds ffmpeg can't encode. */
  private async makeClips(): Promise<{ directory: string; clips: Clip[] }> {
    const directory = await mkdtemp(join(tmpdir(), "findr-hardware-"));
    const clips: Clip[] = [];
    for (const recipe of CLIP_RECIPES) {
      const path = join(directory, `${recipe.kind}.mkv`);
      const tenBit = recipe.pixelFormat.includes("10");
      // The 10-bit HEVC clip's frames are tagged HDR10, for the tone mapping check; tone mappers refuse untagged video
      const hdr = recipe.kind === "hevc10" ? ["-vf", "setparams=color_primaries=bt2020:color_trc=smpte2084:colorspace=bt2020nc"] : [];
      const failure = await this.run([
        "-f", "lavfi", "-i", `testsrc2=size=${CLIP_WIDTH}x${CLIP_HEIGHT}:rate=24`, "-frames:v", "12", ...hdr,
        "-c:v", recipe.encoder, ...recipe.extra, "-pix_fmt", recipe.pixelFormat, "-g", "12", "-y", path,
      ]);
      if (failure === null) clips.push({ kind: recipe.kind, path, tenBit });
    }
    return { directory, clips };
  }
}

/** One line on what a report found. */
function describe(report: Omit<HardwareReport, "durationMs">): string {
  const parts = [`encodes with ${report.encoder}`];
  if (report.decodes.length > 0) parts.push(`decodes ${report.decodes.join(", ")}`);
  if (report.scales) parts.push("scales");
  if (report.toneMaps) parts.push("tone maps");
  return parts.join(", ");
}

// ---------- Ladder ---------- //

/**
 * Where one transcode is on the ladder. It starts on the highest rung the
 * hardware report allows for this video, skipping rungs that failed before
 * for the same kind of transcode, and steps down when a run fails before
 * producing anything.
 */
export class TranscodeLadder {
  /** The rung runs are built for now. */
  public rung: Rung;
  /** What kind of transcode this is, for remembering failures: API, video kind, scaling and tone mapping. */
  public readonly key: string;

  constructor(
    private readonly probe: HardwareProbe,
    private readonly report: HardwareReport,
    private readonly plan: PlaybackPlan,
    private readonly source: TranscodeSource,
    private readonly settings: PlaybackSettings,
    private readonly kind: DecodeKind | null,
  ) {
    this.key = `${report.api}|${kind ?? plan.sourceVideoCodec}|${plan.scaleToHeight !== null}|${plan.toneMap}`;
    this.rung = this.firstFrom(0) ?? "cpu";
  }

  /** The API runs are built for. */
  public get api(): HardwareApi {
    return this.report.api;
  }

  /** Whether video is encoded on the hardware. */
  public get hardware(): boolean {
    return this.report.api !== "none" && this.rung !== "cpu";
  }

  /** The video arguments for a run, with forced keyframes every `keyframeSeconds`. */
  public args(keyframeSeconds: number): VideoArgs {
    return TranscodePipeline.build(this.report.api, this.rung, this.encode(keyframeSeconds), this.source, this.settings, Ffmpeg.filterNames, this.report.scales);
  }

  /**
   * Moves down past a rung that failed, remembering the failure. With
   * `sameEncoder`, as once a stream's codec configuration has been sent,
   * it won't step down to x264. Returns false when there is nowhere lower.
   */
  public stepDown(reason: string, sameEncoder = false): boolean {
    const failed = this.rung;
    this.probe.recordFailure(this.key, failed);
    const next = this.firstFrom(RUNGS.indexOf(failed) + 1);
    if (!next || (sameEncoder && next === "cpu" && failed !== "cpu")) return false;
    console.warn(`[Playback] ${this.report.api} failed at the ${failed} rung (${reason.slice(0, 200)}); trying ${next}`);
    this.rung = next;
    return true;
  }

  /** The first rung from `index` down that the report allows and hasn't failed for this kind. */
  private firstFrom(index: number): Rung | null {
    const failed = this.probe.failed(this.key);
    for (const rung of RUNGS.slice(index)) {
      if (!failed.has(rung) && this.allows(rung)) return rung;
    }
    return null;
  }

  /** Whether the report says a rung can run for this transcode. */
  private allows(rung: Rung): boolean {
    const { report } = this;
    if (rung === "cpu") return true;
    if (report.api === "none" || !report.encodes) return false;
    if (rung === "encode") return true;
    const decodes = this.kind !== null && report.decodes.includes(this.kind);
    if (rung === "decode") return decodes;
    // The device rung also needs every device filter this transcode uses
    const converts = this.plan.scaleToHeight !== null || this.source.bitDepth > 8;
    return decodes && (!converts || report.scales) && (!this.plan.toneMap || report.toneMaps) && TranscodePipeline.deviceRungPossible(report.api, this.encode(2), this.source);
  }

  /** What the plan asks of the encoder. */
  private encode(keyframeSeconds: number): VideoEncode {
    return {
      scaleToHeight: this.plan.scaleToHeight,
      bitrateCap: this.plan.videoBitrateCap,
      bitrateEstimate: Math.max(this.plan.bitrate - (this.plan.audio === "encode" ? AUDIO_BITRATE : 0), 500_000),
      toneMap: this.plan.toneMap,
      keyframeSeconds,
    };
  }
}
