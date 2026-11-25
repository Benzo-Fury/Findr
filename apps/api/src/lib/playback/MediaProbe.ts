/**
 * Reads what a library file holds with ffprobe: its duration and bitrate,
 * the video stream's codec, size, depth and dynamic range, every audio
 * track, and the time of every video keyframe. Playback decides how to send a
 * file from this, and cuts remuxed segments on the keyframes, so it is read
 * once when the file is indexed and stored with it.
 *
 * Times are measured from the start of the file (its first timestamp), the
 * same zero ffmpeg's output starts from.
 */

import { z } from "zod";
import { FfmpegLocator } from "../media/FfmpegLocator";
import { MediaInput } from "../media/MediaInput";
import { Ffmpeg } from "./Ffmpeg";

// ---------- Types ---------- //

/** The video stream playback uses. */
export interface ProbedVideo {
  /** Stream index within the file, as ffmpeg's `-map 0:<index>` takes it. */
  index: number;
  codec: string;
  width: number;
  height: number;
  bitDepth: number;
  hdr: boolean;
  /** ffprobe's profile name, such as `High` or `Main 10`; absent from files probed before it was read. */
  profile?: string | null;
  /** ffprobe's level number: 41 for H.264 level 4.1, 30 times the level for HEVC. */
  level?: number | null;
  /** Frames per second. */
  frameRate?: number | null;
  /** The transfer characteristics, such as `bt709` or `smpte2084`. */
  transfer?: string | null;
}

/** One audio track. */
export interface ProbedAudio {
  index: number;
  codec: string;
  channels: number;
  language: string | null;
  title: string | null;
  isDefault: boolean;
}

/** Everything playback needs to know about a file, stored with its media item. */
export interface ProbeInfo {
  /** Which `PROBE_VERSION` read it; a file read by an older one is read again. */
  version?: number;
  durationMs: number;
  /** Overall bitrate in bits per second. */
  bitrate: number;
  /** The file's first timestamp in seconds; keyframe times are relative to it. */
  startTime: number;
  video: ProbedVideo;
  audio: ProbedAudio[];
}

/** Thrown when a file can't be read or holds nothing playable. */
export class ProbeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProbeError";
  }
}

// ---------- ffprobe output ---------- //

/** The parts of `ffprobe -show_format -show_streams` that are read. */
const ProbeOutputSchema = z.object({
  format: z.object({
    duration: z.string().optional(),
    bit_rate: z.string().optional(),
    start_time: z.string().optional(),
    size: z.string().optional(),
  }),
  streams: z.array(
    z.object({
      index: z.number(),
      codec_type: z.string().optional(),
      codec_name: z.string().optional(),
      width: z.number().optional(),
      height: z.number().optional(),
      pix_fmt: z.string().optional(),
      bits_per_raw_sample: z.string().optional(),
      color_transfer: z.string().optional(),
      profile: z.string().optional(),
      level: z.number().optional(),
      avg_frame_rate: z.string().optional(),
      r_frame_rate: z.string().optional(),
      channels: z.number().optional(),
      disposition: z.object({ default: z.number().optional(), attached_pic: z.number().optional() }).partial().optional(),
      tags: z.record(z.string(), z.string()).optional(),
    }),
  ),
});

/** Bumped when the probe reads something new, so files indexed before are read again. */
export const PROBE_VERSION = 2;

/** Transfer characteristics that mark HDR video (PQ and HLG). */
const HDR_TRANSFERS = new Set(["smpte2084", "arib-std-b67"]);

// ---------- MediaProbe ---------- //

export class MediaProbe {
  /** Reads a file's streams and duration. */
  public async probe(path: string, signal?: AbortSignal): Promise<ProbeInfo> {
    // Library files are Matroska; anything else is never handed to ffprobe
    const format = await MediaInput.sniff(path).catch(() => null);
    if (format !== "matroska") throw new ProbeError("Not a Matroska file");

    const output = await Ffmpeg.run(
      FfmpegLocator.path("ffprobe"),
      ["-v", "error", "-print_format", "json", "-show_format", "-show_streams", ...MediaInput.args("matroska", path)],
      signal,
    );
    if (output.exitCode !== 0) throw new ProbeError(`ffprobe failed: ${output.stderr.trim() || `exit ${output.exitCode}`}`);

    let parsed: z.infer<typeof ProbeOutputSchema>;
    try {
      parsed = ProbeOutputSchema.parse(JSON.parse(output.stdout));
    } catch (error) {
      throw new ProbeError(`Unreadable ffprobe output: ${error instanceof Error ? error.message : error}`);
    }
    return this.describe(parsed);
  }

  /**
   * Every video keyframe time in seconds, relative to the file's start. Reads
   * the packet index rather than decoding, so it costs one pass over the file.
   */
  public async keyframes(path: string, startTime: number, signal?: AbortSignal): Promise<Float64Array> {
    const output = await Ffmpeg.run(
      FfmpegLocator.path("ffprobe"),
      ["-v", "error", "-select_streams", "v:0", "-show_entries", "packet=pts_time,flags", "-of", "csv=p=0", ...MediaInput.args("matroska", path)],
      signal,
    );
    if (output.exitCode !== 0) throw new ProbeError(`ffprobe keyframe scan failed: ${output.stderr.trim() || `exit ${output.exitCode}`}`);

    // Keep keyframe packets only, in time order
    const times: number[] = [];
    for (const line of output.stdout.split("\n")) {
      const [time, flags] = line.split(",");
      if (!flags?.includes("K")) continue;
      const seconds = Number(time) - startTime;
      if (Number.isFinite(seconds)) times.push(Math.max(0, seconds));
    }
    times.sort((a, b) => a - b);
    if (times.length === 0) throw new ProbeError("The video has no keyframes");
    return Float64Array.from(times);
  }

  /** Turns ffprobe's output into what playback stores. */
  private describe(output: z.infer<typeof ProbeOutputSchema>): ProbeInfo {
    const duration = Number(output.format.duration);
    if (!Number.isFinite(duration) || duration <= 0) throw new ProbeError("The file has no duration");

    // The first real video stream, skipping cover art
    const video = output.streams.find((stream) => stream.codec_type === "video" && stream.disposition?.attached_pic !== 1);
    if (!video?.codec_name || !video.width || !video.height) throw new ProbeError("The file has no video stream");

    const audio = output.streams.filter((stream) => stream.codec_type === "audio" && stream.codec_name);
    if (audio.length === 0) throw new ProbeError("The file has no audio stream");

    // Fall back to size over duration when the container states no bitrate
    const stated = Number(output.format.bit_rate);
    const bitrate = Number.isFinite(stated) && stated > 0 ? stated : Math.round((Number(output.format.size ?? 0) * 8) / duration);

    return {
      version: PROBE_VERSION,
      durationMs: Math.round(duration * 1000),
      bitrate,
      startTime: Number(output.format.start_time) || 0,
      video: {
        index: video.index,
        codec: video.codec_name,
        width: video.width,
        height: video.height,
        bitDepth: this.bitDepth(video.pix_fmt, video.bits_per_raw_sample),
        hdr: HDR_TRANSFERS.has(video.color_transfer ?? ""),
        profile: video.profile?.trim() || null,
        // ffprobe reports an unknown level as a negative number
        level: video.level !== undefined && video.level > 0 ? video.level : null,
        frameRate: this.frameRate(video.avg_frame_rate) ?? this.frameRate(video.r_frame_rate),
        transfer: video.color_transfer?.trim() || null,
      },
      audio: audio.map((stream) => ({
        index: stream.index,
        codec: stream.codec_name ?? "unknown",
        channels: stream.channels ?? 2,
        language: this.language(stream.tags?.language),
        title: stream.tags?.title?.trim() || null,
        isDefault: stream.disposition?.default === 1,
      })),
    };
  }

  /** Bits per sample, from the raw sample size or the pixel format's name (e.g. `yuv420p10le`). */
  private bitDepth(pixelFormat: string | undefined, rawBits: string | undefined): number {
    const raw = Number(rawBits);
    if (Number.isFinite(raw) && raw > 0) return raw;
    const match = /p(\d{2})(le|be)?$/.exec(pixelFormat ?? "");
    return match ? Number(match[1]) : 8;
  }

  /** Frames per second from a fraction such as `24000/1001`; null when unknown. */
  private frameRate(fraction: string | undefined): number | null {
    const [numerator, denominator = "1"] = (fraction ?? "").split("/");
    const rate = Number(numerator) / Number(denominator);
    return Number.isFinite(rate) && rate > 0 && rate < 1000 ? Math.round(rate * 1000) / 1000 : null;
  }

  /** A track's language code, or null for none or undetermined. */
  private language(tag: string | undefined): string | null {
    const code = tag?.trim().toLowerCase();
    return code && code !== "und" ? code : null;
  }
}
